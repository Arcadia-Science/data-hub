from __future__ import annotations
import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from data_hub_watcher.api_client import (
    DEFAULT_TIMEOUT,
    ApiError,
    DataHubClient,
    timeout_until,
)
from data_hub_watcher.constants import (
    HEARTBEAT_INTERVAL_SECONDS,
    WATCHER_VERSION,
)
from data_hub_watcher.events import EventReporter

logger = logging.getLogger(__name__)


@dataclass
class WatcherCounters:
    """Mutable counters reset after each heartbeat.

    The ``last_*`` snapshots persist across resets so consumers that run
    *after* a heartbeat (e.g. the updater on the post-heartbeat tick
    callback) can still observe the activity from the just-elapsed
    interval. Without these the post-reset value is always zero, which
    would falsely look like an idle window.
    """

    files_uploaded: int = 0
    runs_reported: int = 0
    errors: int = 0
    last_files_uploaded: int = 0
    last_runs_reported: int = 0
    last_errors: int = 0


class HeartbeatLoop:
    """Sends periodic heartbeats and flushes queued events."""

    def __init__(
        self,
        client: DataHubClient,
        watcher_id: str,
        interval_seconds: int,
        event_reporter: EventReporter,
        instrument_id: str,
        watch_directory: str,
        upload_mode: str,
        counters: WatcherCounters | None = None,
        on_tick: Callable[[], None] | None = None,
        status: str = "watching",
        status_reason: str | None = None,
        config_revision: Callable[[], int | None] | None = None,
        on_config_revision: Callable[[int | None], None] | None = None,
    ) -> None:
        self._client = client
        self._watcher_id = watcher_id
        self._interval = interval_seconds
        self._event_reporter = event_reporter
        self._instrument_id = instrument_id
        self._watch_directory = watch_directory
        self._upload_mode = upload_mode
        self.counters = counters or WatcherCounters()
        self._on_tick = on_tick
        # "watching" normally. "waiting" while the watch folder is missing, in
        # which case `status_reason` says why and only this loop runs.
        self._status = status
        self._status_reason = status_reason
        # Returns the highest config revision this watcher has applied, sent
        # as `config_revision`. `None` leaves the field out (older callers).
        self._config_revision = config_revision
        # Called with the reply's `config_revision` (the server's latest) after
        # every successful heartbeat, so the runtime can fetch a new revision.
        self._on_config_revision = on_config_revision

        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._start_time: float = 0.0
        # Track consecutive heartbeat failures so we can emit a
        # ``kind=heartbeat_recovered`` event on the first success after
        # an outage. Emitting *during* the outage would itself fail
        # (the network is the very thing that's down) so the recovery
        # event is the only reliable signal.
        self._consecutive_heartbeat_failures = 0
        self._first_failure_at: float | None = None

    def start(self) -> None:
        """Send an immediate heartbeat, then run periodic heartbeats in a thread.

        The synchronous startup beat is critical because ``start()`` is
        always called immediately before ``FileMonitor.start()`` runs the
        initial directory scan, which can block the main thread for
        several minutes on large or networked watch volumes. Without the
        immediate beat, the dashboard would see nothing for the full
        scan window plus up to one ``interval``, and the watcher would
        be indistinguishable from a hung process — especially painful on
        Windows where the service runs headless and the only liveness
        signal an operator has is what shows up in Data Hub.

        We also flush the event reporter on this initial tick so the
        ``WATCHER_STARTED`` event the runtime queued moments ago becomes
        visible right away rather than piggy-backing on the first
        loop-driven flush ~``interval`` seconds later.
        """
        self._start_time = time.monotonic()
        self._stop_event.clear()
        # Synchronous startup beat + flush so the dashboard sees the
        # watcher come up before the (potentially long-running) initial
        # scan begins. ``_send_heartbeat`` and ``flush`` both swallow
        # network errors internally, so a startup with the API
        # unreachable still proceeds — the next loop tick will retry
        # and emit the standard ``heartbeat_recovered`` event when the
        # link comes back.
        self._send_heartbeat(status=self._status)
        self._event_reporter.flush()
        self._thread = threading.Thread(target=self._run, daemon=True, name="heartbeat")
        self._thread.start()

    def set_status_reason(self, reason: str | None) -> None:
        """Change the ``status_reason`` sent from the next heartbeat on."""
        self._status_reason = reason

    def stop(self, *, send_stopped: bool = True, stop_reason: str | None = None) -> None:
        """Stop the loop and, unless *send_stopped* is false, send the final heartbeat.

        *stop_reason* is the `status_reason` of that heartbeat (see `send_final_heartbeat`).

        Both halves have no time limit: this waits as long as a tick in progress can take,
        and sends the final heartbeat with the client's usual timeout. A stop that has a
        deadline calls `stop_loop` and `send_final_heartbeat` itself, with the events sent
        in between (see `stop_runtime`). The config rebuild calls this with
        *send_stopped* false.
        """
        self.stop_loop()
        if send_stopped:
            self.send_final_heartbeat(stop_reason=stop_reason)

    def stop_loop(self, *, join_timeout: float | None = None) -> bool:
        """Stop the periodic heartbeats and wait for a tick in progress. Sends nothing.

        Returns whether the loop's thread has exited (`True` too when it never ran).

        A tick is a heartbeat request, which can run for tens of seconds, an event flush and
        an update check. The final "stopped" heartbeat must not overtake that tick's
        "watching" one, or the server ends on "watching". So with no *join_timeout* the wait
        is as long as a tick can take, and never drops below the production interval, which
        a short test override of the interval would otherwise shrink.

        A stop with a deadline passes a *join_timeout* in seconds. A tick that is still
        running after it is left behind: it is a daemon thread, and it ends with the
        process. If its request is slow, its "watching" heartbeat can reach the server
        after the "stopped" one, which is no worse than a watcher that was killed: the
        server marks the PC offline when no heartbeat follows.
        """
        self._stop_event.set()
        if self._thread and self._thread.is_alive():
            if join_timeout is None:
                join_timeout = max(self._interval, HEARTBEAT_INTERVAL_SECONDS) + 5
            self._thread.join(timeout=join_timeout)
        return self.has_exited()

    def has_exited(self) -> bool:
        """Whether the loop's thread is gone: never started, or ended after a stop."""
        return self._thread is None or not self._thread.is_alive()

    def send_final_heartbeat(
        self,
        *,
        stop_reason: str | None = None,
        deadline: float | None = None,
        timeout_cap: tuple[float, float] = DEFAULT_TIMEOUT,
    ) -> None:
        """Send the final "stopped" heartbeat, so the server knows the watcher shut down
        gracefully rather than silently disappearing.

        A rebuild for a new config doesn't send it, because a new loop starts straight away
        and the watcher never actually stops.

        *stop_reason* is the `status_reason` of that heartbeat:
        `SYSTEM_SHUTDOWN_STATUS_REASON` when Windows is shutting down or restarting,
        `AUTO_UPDATE_STATUS_REASON` when the watcher stops to install an automatic
        update. The server then keeps the instrument's requested uploads queued for
        the watcher to upload once it starts again, instead of cancelling them as it
        does for any other stop.

        *deadline* (a `time.monotonic()` value) is when the request should be done. Its HTTP
        timeout is *timeout_cap*, the client's usual one unless told otherwise, cut down to
        fit before the deadline. A deadline that has passed only makes the request short: it
        is the one request that matters, so it is still sent. Without a *deadline* the
        client's usual timeout applies.
        """
        self._send_heartbeat(
            status="stopped",
            stop_reason=stop_reason,
            timeout=None if deadline is None else timeout_until(deadline, timeout_cap),
        )

    def _run(self) -> None:
        # Event.wait() returns True when set (stop requested) and False on timeout,
        # so the loop fires a tick every interval and exits immediately on stop.
        while not self._stop_event.wait(timeout=self._interval):
            self._tick()

    def _tick(self) -> None:
        # Heartbeat first, then flush events — the heartbeat tells the server
        # the watcher is alive, and flushing piggybacks on that liveness signal.
        self._send_heartbeat(status=self._status)
        if self._stop_event.is_set():
            # A stop came while the heartbeat was in flight. It sends the events and the final
            # heartbeat itself, whether it gave up on this tick (see `stop_loop`) or waited for
            # it. A flush here could send `watcher_stopped` out of order with no deadline, or
            # lose it at exit, and the updater could be run against a state database that is
            # closed, or even start an update during the stop.
            return
        self._event_reporter.flush()
        if self._on_tick is not None:
            self._on_tick()

    def _send_heartbeat(
        self,
        status: str = "watching",
        *,
        stop_reason: str | None = None,
        timeout: tuple[float, float] | None = None,
    ) -> None:
        payload = self._build_payload(status, stop_reason=stop_reason)
        try:
            response = self._client.send_heartbeat(self._watcher_id, payload, timeout=timeout)
        except (ApiError, Exception) as exc:
            logger.warning("Heartbeat failed: %s", exc)
            if self._consecutive_heartbeat_failures == 0:
                self._first_failure_at = time.monotonic()
            self._consecutive_heartbeat_failures += 1
        else:
            if self._consecutive_heartbeat_failures > 0:
                # Recovery — emit a single event covering the full
                # outage so the dashboard can correlate the gap with
                # whatever was happening on the network at the time.
                gap_seconds = (
                    int(time.monotonic() - self._first_failure_at)
                    if self._first_failure_at is not None
                    else 0
                )
                self._event_reporter.report_error(
                    "heartbeat_recovered",
                    (
                        f"Heartbeat recovered after "
                        f"{self._consecutive_heartbeat_failures} consecutive failure(s)"
                    ),
                    consecutive_failures=self._consecutive_heartbeat_failures,
                    gap_seconds=gap_seconds,
                )
                self._consecutive_heartbeat_failures = 0
                self._first_failure_at = None
            if self._on_config_revision is not None and status != "stopped":
                # Older servers leave `config_revision` out of the reply, so
                # anything but an int means "no revision".
                latest = getattr(response, "config_revision", None)
                try:
                    self._on_config_revision(latest if isinstance(latest, int) else None)
                except Exception:
                    logger.exception("Config revision callback failed")

        # Snapshot the just-sent values into the `last_*` fields so post-reset
        # consumers (e.g. the updater) can still see the most recent interval's
        # activity. Then reset the live counters so the next heartbeat only
        # reports activity since the previous one, not cumulative.
        self.counters.last_files_uploaded = self.counters.files_uploaded
        self.counters.last_runs_reported = self.counters.runs_reported
        self.counters.last_errors = self.counters.errors
        self.counters.files_uploaded = 0
        self.counters.runs_reported = 0
        self.counters.errors = 0

    def _build_payload(self, status: str, *, stop_reason: str | None = None) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "status": status,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "instrument_id": self._instrument_id,
            "watch_directory": self._watch_directory,
            "upload_mode": self._upload_mode,
            "watcher_version": WATCHER_VERSION,
            "files_uploaded_since_last_heartbeat": self.counters.files_uploaded,
            "runs_reported_since_last_heartbeat": self.counters.runs_reported,
            "errors_since_last_heartbeat": self.counters.errors,
            "uptime_seconds": int(time.monotonic() - self._start_time),
        }
        if status == "waiting" and self._status_reason:
            # The server caps `status_reason` at 500 characters.
            payload["status_reason"] = self._status_reason[:500]
        elif status == "stopped" and stop_reason:
            payload["status_reason"] = stop_reason
        if self._config_revision is not None:
            payload["config_revision"] = self._config_revision()
        return payload
