from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from data_hub_watcher.api_client import ApiError, DataHubClient
from data_hub_watcher.events import EventReporter

logger = logging.getLogger(__name__)


@dataclass
class WatcherCounters:
    """Mutable counters reset after each heartbeat."""

    files_uploaded: int = 0
    runs_reported: int = 0
    errors: int = 0


class HeartbeatLoop:
    """Sends periodic heartbeats and flushes queued events."""

    def __init__(
        self,
        client: DataHubClient,
        watcher_id: str,
        interval_seconds: int,
        event_reporter: EventReporter,
        counters: WatcherCounters | None = None,
    ) -> None:
        self._client = client
        self._watcher_id = watcher_id
        self._interval = interval_seconds
        self._event_reporter = event_reporter
        self.counters = counters or WatcherCounters()

        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._start_time: float = 0.0

    def start(self) -> None:
        self._start_time = time.monotonic()
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, daemon=True, name="heartbeat")
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=self._interval + 5)
        # Send a final "stopped" heartbeat so the server knows the watcher
        # shut down gracefully rather than silently disappearing.
        self._send_heartbeat(status="stopped")

    def _run(self) -> None:
        # Event.wait() returns True when set (stop requested) and False on timeout,
        # so the loop fires a tick every interval and exits immediately on stop.
        while not self._stop_event.wait(timeout=self._interval):
            self._tick()

    def _tick(self) -> None:
        # Heartbeat first, then flush events — the heartbeat tells the server
        # the watcher is alive, and flushing piggybacks on that liveness signal.
        self._send_heartbeat(status="watching")
        self._event_reporter.flush()

    def _send_heartbeat(self, status: str = "watching") -> None:
        payload = self._build_payload(status)
        try:
            self._client.send_heartbeat(self._watcher_id, payload)
        except (ApiError, Exception) as exc:
            logger.warning("Heartbeat failed: %s", exc)

        # Reset counters after every attempt (success or failure) so the next
        # heartbeat only reports activity since the previous one, not cumulative.
        self.counters.files_uploaded = 0
        self.counters.runs_reported = 0
        self.counters.errors = 0

    def _build_payload(self, status: str) -> dict[str, Any]:
        return {
            "status": status,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "files_uploaded_since_last_heartbeat": self.counters.files_uploaded,
            "runs_reported_since_last_heartbeat": self.counters.runs_reported,
            "errors_since_last_heartbeat": self.counters.errors,
            "uptime_seconds": int(time.monotonic() - self._start_time),
        }