"""In-process self-update orchestrated from the running watcher service.

The operator-facing ``data-hub-watcher self-update`` CLI command (see
``self_update.py``) lets operators trigger an upgrade interactively, but
unattended lab PCs need a path that doesn't require anyone to log in. The
``Updater`` class below runs from inside the heartbeat loop, polls the
server's ``/update-check`` endpoint roughly hourly, and -- when an update
is both available and safe to apply (no recent uploads, no recent run
activity, not a preview environment) -- shells out to the same
``run_upgrade`` subprocess used by the CLI. On success it asks the runtime
to exit non-zero so the Windows SCM's failure-actions config restarts the
service into the new version.

To detect upgrades that don't take effect (e.g. the new code crashes at
startup so the service stays in a restart loop) the updater writes an
``.upgrade-in-progress`` marker file under ``~/.data-hub`` *before* it
runs the upgrade subprocess. The next process startup inspects the
marker, compares ``WATCHER_VERSION`` against the recorded target, and
emits ``UPDATE_SUCCEEDED`` or ``UPDATE_FAILED`` accordingly. The marker
is then cleared so a single failure isn't reported indefinitely.
"""

from __future__ import annotations
import json
import logging
import sys
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from data_hub_watcher.api_client import ApiError, DataHubClient
from data_hub_watcher.constants import HEARTBEAT_INTERVAL_SECONDS, WATCHER_VERSION
from data_hub_watcher.events import EventReporter, EventType, WatcherEvent
from data_hub_watcher.heartbeat import WatcherCounters
from data_hub_watcher.models import WatcherConfig, WatcherUpdateInfoResponse
from data_hub_watcher.self_update import (
    DEFAULT_INDEX_URL,
    InstallMethod,
    UvExecutableNotFoundError,
    _resolve_uv_executable,
    build_upgrade_command,
    detect_install_method,
    evaluate_update,
    run_upgrade,
)
from data_hub_watcher.state import StateDB
from data_hub_watcher.upgrade_worker import (
    build_pkg_spec,
    detect_installed_extras,
    write_upgrade_request,
)

logger = logging.getLogger(__name__)


UPGRADE_MARKER_FILENAME = ".upgrade-in-progress"

# Default cadence: with a 60-second heartbeat, this works out to roughly
# "5 minutes idle before we even consider an update" and "one update
# check per hour". Both are deliberately conservative — we'd rather miss
# an update window than interrupt a running experiment.
DEFAULT_IDLE_TICKS_REQUIRED = 5
DEFAULT_CHECK_INTERVAL_TICKS = 60

# Multiplier on `stability_period_seconds` used to decide whether the
# instrument has been quiet long enough to safely restart. 5x means a
# config with the default 5-second stability window only auto-updates
# when no run has been reported in the last 25 seconds — short enough
# to allow updates between experiments, long enough that we won't
# clobber a multi-file run mid-acquisition.
DEFAULT_RUN_QUIET_MULTIPLIER = 5


@dataclass
class UpdaterConfig:
    """Tunable knobs for the auto-update gate."""

    idle_ticks_required: int = DEFAULT_IDLE_TICKS_REQUIRED
    check_interval_ticks: int = DEFAULT_CHECK_INTERVAL_TICKS
    # If set, overrides the `stability_period_seconds * multiplier`
    # default. Tests use a small explicit value so they don't have to
    # reason about heartbeat timing.
    min_run_age_seconds: float | None = None
    run_quiet_multiplier: int = DEFAULT_RUN_QUIET_MULTIPLIER
    # When True (the production default), the very first heartbeat tick
    # after process startup fires an ``/update-check`` API call instead
    # of waiting a full ``check_interval_ticks`` window — so a fresh
    # service restart picks up a pending release within one heartbeat
    # interval (~60 s) rather than up to an hour. The activity-window
    # gates inside ``should_attempt_update`` still apply: if an upload
    # or run was happening when the previous instance died, the
    # ``last_run_age_seconds`` / ``idle_ticks_required`` checks defer
    # the actual upgrade attempt as designed. The on-start fast path
    # only short-circuits the *cadence* part of the gate, not the
    # *safety* part. Tests opt out via ``check_on_start=False`` so
    # their existing cadence assertions (``for _ in range(N): on_tick();
    # then trigger on the (N+1)th``) keep working unchanged.
    check_on_start: bool = True


@dataclass
class UpdateAttemptResult:
    """Outcome of a single ``Updater.on_tick`` invocation.

    Returned (rather than only logged) so unit tests can assert the
    exact decision path without monkeypatching logging.

    ``succeeded`` is ``True`` / ``False`` for finished decisions, and
    ``None`` when an upgrade subprocess was dispatched off-thread but
    its result isn't available yet (the heartbeat-thread caller
    returns immediately rather than blocking on the subprocess).
    """

    attempted: bool
    succeeded: bool | None
    reason: str
    target_version: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Marker file helpers
# ---------------------------------------------------------------------------


def upgrade_marker_path(config_dir: Path) -> Path:
    return config_dir / UPGRADE_MARKER_FILENAME


def write_upgrade_marker(
    config_dir: Path,
    *,
    target_version: str,
    previous_version: str,
) -> Path:
    """Persist a JSON marker recording an in-flight upgrade.

    Written *before* the upgrade subprocess runs so a crash mid-upgrade
    still leaves a trail for the post-restart inspection in
    :func:`evaluate_upgrade_marker`.
    """
    config_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "target_version": target_version,
        "previous_version": previous_version,
        "started_at": datetime.now(timezone.utc).isoformat(),
    }
    path = upgrade_marker_path(config_dir)
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def clear_upgrade_marker(config_dir: Path) -> None:
    upgrade_marker_path(config_dir).unlink(missing_ok=True)


@dataclass
class UpgradeMarkerOutcome:
    """Result of inspecting a post-restart upgrade marker."""

    found: bool
    succeeded: bool | None
    target_version: str | None
    previous_version: str | None
    reason: str


def evaluate_upgrade_marker(
    config_dir: Path,
    *,
    current_version: str = WATCHER_VERSION,
) -> UpgradeMarkerOutcome:
    """Read and clear an upgrade marker, classifying the outcome.

    Called once per process start (from ``start_runtime``). If the marker
    is absent, returns a "no-op" outcome and the runtime emits no events.
    Otherwise the runtime queues an ``UPDATE_SUCCEEDED`` /
    ``UPDATE_FAILED`` event based on whether ``current_version`` matches
    the recorded target.
    """
    path = upgrade_marker_path(config_dir)
    if not path.exists():
        return UpgradeMarkerOutcome(
            found=False,
            succeeded=None,
            target_version=None,
            previous_version=None,
            reason="no marker present",
        )

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        # Corrupt marker — drop it so we don't keep reporting the same
        # failure on every restart, but still flag it so an operator can
        # investigate via the server-side event log.
        path.unlink(missing_ok=True)
        return UpgradeMarkerOutcome(
            found=True,
            succeeded=False,
            target_version=None,
            previous_version=None,
            reason=f"marker unreadable: {exc}",
        )

    target = data.get("target_version") if isinstance(data, dict) else None
    previous = data.get("previous_version") if isinstance(data, dict) else None
    path.unlink(missing_ok=True)

    if target == current_version:
        return UpgradeMarkerOutcome(
            found=True,
            succeeded=True,
            target_version=target,
            previous_version=previous,
            reason="restarted into target version",
        )

    return UpgradeMarkerOutcome(
        found=True,
        succeeded=False,
        target_version=target,
        previous_version=previous,
        reason=(f"expected {target!r} after upgrade, running {current_version!r}"),
    )


# ---------------------------------------------------------------------------
# Pure decision function — kept stand-alone for unit testing
# ---------------------------------------------------------------------------


def should_attempt_update(
    info: WatcherUpdateInfoResponse,
    *,
    current_version: str,
    idle_ticks: int,
    idle_ticks_required: int,
    last_run_age_seconds: float | None,
    min_run_age_seconds: float,
) -> tuple[bool, str]:
    """Decide whether the in-process updater should fire right now.

    The version-comparison half delegates to :func:`evaluate_update` so
    we share the same "newer / mandatory / un-parseable" logic with the
    operator-facing CLI command. The activity-window half is exclusive
    to the in-process path: the CLI doesn't care whether the watcher is
    busy because the operator triggered it explicitly.
    """
    decision = evaluate_update(info, current_version=current_version)
    if not decision.should_update:
        return False, decision.reason

    if info.mandatory:
        # Mandatory rollouts override the activity-window guard. The
        # rationale: if a release is mandatory it's typically a security
        # fix or wire-protocol change, and the cost of taking the
        # watcher down briefly is lower than the cost of leaving a
        # known-bad version running.
        return True, "mandatory rollout"

    if idle_ticks < idle_ticks_required:
        return (
            False,
            f"recent upload activity ({idle_ticks}/{idle_ticks_required} idle ticks)",
        )

    if last_run_age_seconds is not None and last_run_age_seconds < min_run_age_seconds:
        return (
            False,
            (
                f"recent run activity ("
                f"last run {last_run_age_seconds:.0f}s ago, "
                f"need {min_run_age_seconds:.0f}s of quiet)"
            ),
        )

    return True, "idle window and newer version available"


# ---------------------------------------------------------------------------
# Updater
# ---------------------------------------------------------------------------


def _default_upgrade_executor(fn: Callable[[], None]) -> None:
    """Run *fn* on a daemon thread named ``upgrade-worker``.

    The default executor used by :class:`Updater`. Detaching the
    upgrade subprocess from the heartbeat thread is what lets
    heartbeats keep flowing during a slow ``uv tool install``
    (which can take 30–60 s and would otherwise wedge the loop
    long enough for the dashboard to flag the watcher as stale).
    Daemon=True so an interpreter shutdown doesn't block on a
    pending subprocess.
    """
    threading.Thread(target=fn, daemon=True, name="upgrade-worker").start()


class Updater:
    """Heartbeat-tick callback that polls for and applies updates.

    Construction is intentionally side-effect-free — wiring happens in
    :mod:`data_hub_watcher.runtime`. State held: two counters (idle
    ticks observed, ticks-since-last-check), an ``_upgrade_in_progress``
    flag that gates concurrent dispatches, and references to the
    collaborators.
    """

    def __init__(
        self,
        *,
        client: DataHubClient,
        reporter: EventReporter,
        counters: WatcherCounters,
        state_db: StateDB,
        cfg: WatcherConfig,
        config_dir: Path,
        request_upgrade_restart: Callable[[str], None],
        updater_cfg: UpdaterConfig | None = None,
        upgrade_runner: Callable[..., Any] | None = None,
        upgrade_executor: Callable[[Callable[[], None]], None] | None = None,
    ) -> None:
        self._client = client
        self._reporter = reporter
        self._counters = counters
        self._state_db = state_db
        self._cfg = cfg
        self._config_dir = config_dir
        self._request_upgrade_restart = request_upgrade_restart
        c = updater_cfg or UpdaterConfig()
        self._idle_ticks_required = c.idle_ticks_required
        self._check_interval_ticks = c.check_interval_ticks
        self._min_run_age_seconds = (
            c.min_run_age_seconds
            if c.min_run_age_seconds is not None
            else float(cfg.instrument.stability_period_seconds * c.run_quiet_multiplier)
        )
        # Default to the real `run_upgrade` from `self_update`; tests
        # inject a stub that returns a synthetic CompletedProcess so they
        # don't have to monkeypatch a module-level symbol.
        self._upgrade_runner = upgrade_runner or run_upgrade
        # Default executor spawns a daemon thread so the heartbeat
        # loop returns immediately. Tests pass an inline executor
        # (``lambda fn: fn()``) to make the dispatch synchronous and
        # keep their assertions deterministic.
        self._upgrade_executor = upgrade_executor or _default_upgrade_executor

        self._idle_ticks = 0
        # Seed the cadence counter so the very first tick fires an
        # ``/update-check`` API call when ``check_on_start`` is set
        # (the production default). With ``check_interval_ticks=60``
        # and a 60-second heartbeat, the cold-start latency for
        # picking up a pending release drops from "up to 60 minutes"
        # to "~60 seconds" — which matters most during testing
        # iteration (operator runs ``service reinstall``, then sees
        # the next attempt within one heartbeat instead of an hour)
        # but is also a small operability win in production: a host
        # that just rebooted picks up the latest version immediately
        # rather than running stale code for the first hour after
        # boot. The activity-window gates in ``should_attempt_update``
        # still defer the actual upgrade if there's recent run /
        # upload activity, so this short-circuits cadence only — not
        # safety.
        self._ticks_since_check = c.check_interval_ticks if c.check_on_start else 0
        self._upgrade_in_progress = False
        # Per-target memo for the "ineligible install method" refusal
        # path: we want one ``UPDATE_FAILED`` event per *new* server
        # target so admins can spot lab PCs stuck on a dev install
        # during a (possibly mandatory) rollout, but not every hourly
        # tick — which would spam the dashboard for the whole life of
        # the dev install. Reset to ``None`` on process restart so the
        # next start re-establishes state with the server.
        self._last_refused_target: str | None = None
        # Track consecutive ``/update-check`` failures so we surface a
        # ``kind=update_check_failed`` event after 3 consecutive misses
        # (~3 hours of going dark on the update channel). One isolated
        # blip is uninteresting but a sustained inability to check
        # blocks all auto-updates, including mandatory rollouts.
        self._consecutive_update_check_failures = 0
        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    # Heartbeat callback
    # ------------------------------------------------------------------

    def on_tick(self) -> UpdateAttemptResult | None:
        """Run from the heartbeat loop after each successful heartbeat.

        Returns ``None`` on ticks where we don't even attempt a server
        check (the common case). Returns an :class:`UpdateAttemptResult`
        on ticks where we did call ``/update-check``, which lets tests
        assert on the decision without monkeypatching logging.
        """
        with self._lock:
            if self._cfg.environment == "preview":
                # Preview deployments are short-lived URL-suffixed builds
                # and must never push code to production lab PCs.
                return None

            if self._upgrade_in_progress:
                # A previous tick dispatched an upgrade to the executor
                # and the subprocess hasn't returned yet. Skip the API
                # call and counter advancement so we don't double-spawn
                # or spam the dashboard with redundant decisions while
                # the worker is still running.
                return UpdateAttemptResult(
                    attempted=False,
                    succeeded=None,
                    reason="upgrade subprocess already in progress",
                )

            if self._counters.last_files_uploaded == 0:
                self._idle_ticks += 1
            else:
                self._idle_ticks = 0

            self._ticks_since_check += 1
            if self._ticks_since_check < self._check_interval_ticks:
                return None
            self._ticks_since_check = 0

        return self._check_and_apply()

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _check_and_apply(self) -> UpdateAttemptResult:
        watcher_id = self._cfg.watcher_id
        if not watcher_id:
            # Defensive — `build_runtime` already asserts this, but the
            # type system can't see through the assert.
            return UpdateAttemptResult(False, False, "no watcher_id in config", None)

        try:
            info = self._client.get_update_info(watcher_id)
        except ApiError as exc:
            logger.warning("Update-check API call failed: %s", exc)
            self._note_update_check_failure(exc.message)
            return UpdateAttemptResult(False, False, f"update-check API error: {exc.message}", None)
        except Exception as exc:  # pragma: no cover - defensive
            logger.exception("Unexpected error fetching update info")
            self._note_update_check_failure(str(exc))
            return UpdateAttemptResult(False, False, f"unexpected error: {exc}", None)

        # Reset the failure counter on any successful fetch so the next
        # outage's "3 consecutive failures" window is accurate.
        self._consecutive_update_check_failures = 0

        last_run_age = self._last_run_age_seconds()
        ok, reason = should_attempt_update(
            info,
            current_version=WATCHER_VERSION,
            idle_ticks=self._idle_ticks,
            idle_ticks_required=self._idle_ticks_required,
            last_run_age_seconds=last_run_age,
            min_run_age_seconds=self._min_run_age_seconds,
        )
        if not ok:
            logger.debug(
                "Skipping update attempt: %s (current=%s, target=%s)",
                reason,
                WATCHER_VERSION,
                info.latest_version,
            )
            return UpdateAttemptResult(False, False, reason, info.latest_version)

        return self._apply(info)

    def _apply(self, info: WatcherUpdateInfoResponse) -> UpdateAttemptResult:
        target = info.latest_version
        assert target is not None  # guaranteed by should_attempt_update

        method = detect_install_method()
        if method in (InstallMethod.EDITABLE, InstallMethod.UNKNOWN):
            reason = f"install method {method.value!r} not eligible for auto-update"
            logger.info("Refusing auto-update: %s", reason)
            # Emit one UPDATE_FAILED per new server target so the
            # dashboard surfaces stuck dev/unknown installs — critical
            # during a mandatory rollout where the operator needs to
            # know which PCs aren't going to apply the release. The
            # `_last_refused_target` memo throttles repeats: a developer
            # box on an editable install would otherwise generate one
            # event per hourly tick for the entire life of the install.
            if self._last_refused_target != target:
                self._emit_failure(
                    target,
                    reason,
                    extra={"install_method": method.value, "attempted_subprocess": False},
                )
                self._last_refused_target = target
            return UpdateAttemptResult(True, False, reason, target, {"method": method.value})

        # Windows uv-tool installs cannot reinstall in-process: the
        # service's own ``Scripts\\python.exe`` is the file ``uv``
        # would need to delete. Route those through the SYSTEM-owned
        # scheduled-task worker instead, which stops the service
        # before invoking ``uv``. POSIX uv-tool, Windows pip, and
        # POSIX pip continue to use the inline subprocess path —
        # they don't have the lock issue and the inline path gives
        # the dashboard live UPDATE_STARTED → UPDATE_FAILED pairing
        # without an extra hop through a sentinel file.
        if sys.platform == "win32" and method is InstallMethod.UV_TOOL:
            return self._apply_via_worker(info, method, target)

        return self._apply_in_process(info, method, target)

    def _apply_in_process(
        self,
        info: WatcherUpdateInfoResponse,
        method: InstallMethod,
        target: str,
    ) -> UpdateAttemptResult:
        # Resolve the upgrade argv up-front. Doing this before we emit
        # UPDATE_STARTED / write the marker means a missing `uv` binary
        # (the Windows-service / LocalSystem PATH failure mode) becomes
        # a single diagnosable UPDATE_FAILED with the paths we probed —
        # rather than an UPDATE_STARTED followed by an opaque
        # `[WinError 2] The system cannot find the file specified`
        # from inside subprocess.run.
        try:
            command = build_upgrade_command(method, target_version=target)
        except UvExecutableNotFoundError as exc:
            reason = "uv executable not found"
            logger.warning("Refusing auto-update: %s (%s)", reason, exc)
            self._emit_failure(
                target,
                reason,
                extra={
                    "install_method": method.value,
                    "attempted_subprocess": False,
                    "error_class": type(exc).__name__,
                    "candidates_tried": exc.candidates,
                },
            )
            return UpdateAttemptResult(True, False, reason, target, {"method": method.value})

        details_started: dict[str, Any] = {
            "current_version": WATCHER_VERSION,
            "target_version": target,
            "mandatory": info.mandatory,
            "install_method": method.value,
        }
        self._reporter.queue_event(
            WatcherEvent(
                event_type=EventType.UPDATE_STARTED,
                message=f"Upgrading watcher {WATCHER_VERSION} -> {target}",
                details=details_started,
            )
        )
        # Flush immediately so the dashboard sees UPDATE_STARTED before
        # the upgrade subprocess even starts. The subprocess itself runs
        # off-thread (see executor below) so heartbeats keep flowing,
        # but flushing here also covers the corner case where a slow
        # subprocess delays the next heartbeat.
        self._reporter.flush()

        write_upgrade_marker(
            self._config_dir,
            target_version=target,
            previous_version=WATCHER_VERSION,
        )

        with self._lock:
            self._upgrade_in_progress = True

        # Mutable cell capturing the subprocess outcome. When the
        # executor runs synchronously (test default), the worker fills
        # this in before we return and we surface the real result. When
        # the executor dispatches to a thread (production default), the
        # cell stays empty and we return a "dispatched" placeholder so
        # the heartbeat-thread caller can record what happened on this
        # tick without blocking on the subprocess.
        outcome: list[UpdateAttemptResult] = []

        def _run_upgrade() -> None:
            try:
                try:
                    result = self._upgrade_runner(method, target_version=target)
                except FileNotFoundError as exc:
                    # CreateProcess / execve couldn't find the program.
                    # Usually means `uv` slipped off PATH between our
                    # resolver and the subprocess call (or a permission
                    # error masquerading as one). Classify separately
                    # from the generic `subprocess raised:` branch so
                    # operators don't have to decode `[WinError 2]`.
                    logger.exception("Upgrade subprocess could not start")
                    self._emit_failure(
                        target,
                        f"upgrade command not executable: {exc}",
                        extra={
                            "install_method": method.value,
                            "error_class": type(exc).__name__,
                            "command": command,
                        },
                    )
                    outcome.append(UpdateAttemptResult(True, False, str(exc), target))
                    return
                except Exception as exc:
                    logger.exception("Upgrade subprocess raised")
                    self._emit_failure(
                        target,
                        f"subprocess raised: {exc}",
                        extra={
                            "install_method": method.value,
                            "error_class": type(exc).__name__,
                            "command": command,
                        },
                    )
                    outcome.append(UpdateAttemptResult(True, False, str(exc), target))
                    return

                # Always log the subprocess output to ``watcher.log``
                # regardless of returncode. Historically the only
                # signal we had on a partial-install (uv exits 0
                # despite cleanup failures, or the auto-updater
                # mis-classifies the exit code) was the marker
                # comparison on the next startup — by which point
                # the actual installer error was already lost.
                # Mirroring the output to the local log keeps it
                # recoverable on a lab PC even when the dashboard
                # event ends up incomplete.
                stdout_tail = (result.stdout or "")[-1000:]
                stderr_tail = (result.stderr or "")[-1000:]
                logger.info(
                    "Upgrade subprocess exited %d (stdout tail): %s",
                    result.returncode,
                    stdout_tail or "(empty)",
                )
                if stderr_tail:
                    log_method = logger.warning if result.returncode != 0 else logger.info
                    log_method("Upgrade subprocess stderr tail: %s", stderr_tail)

                if result.returncode != 0:
                    self._emit_failure(
                        target,
                        f"subprocess exited {result.returncode}",
                        extra={
                            "install_method": method.value,
                            "command": command,
                            "stdout_tail": stdout_tail,
                            "stderr_tail": stderr_tail,
                        },
                    )
                    outcome.append(
                        UpdateAttemptResult(True, False, f"exit code {result.returncode}", target)
                    )
                    return

                # The new wheel is installed but the running interpreter
                # still has the old code loaded. UPDATE_SUCCEEDED is
                # emitted from the *next* startup once the marker
                # confirms the new version is actually running — see
                # `evaluate_upgrade_marker`. Here we just request the
                # runtime to exit non-zero so the SCM restarts us.
                logger.info("Upgrade subprocess succeeded; requesting service restart")
                self._request_upgrade_restart(target)
                outcome.append(
                    UpdateAttemptResult(True, True, "upgrade subprocess succeeded", target)
                )
            finally:
                # Always clear the in-progress flag so a one-shot failure
                # doesn't permanently disable future update attempts.
                # On success, the runtime is about to be torn down by
                # `request_upgrade_restart` so the flag's value past
                # this point is moot.
                with self._lock:
                    self._upgrade_in_progress = False

        self._upgrade_executor(_run_upgrade)

        if outcome:
            return outcome[0]

        # Async dispatch: the worker is still running. Return a
        # placeholder reflecting that we kicked off the subprocess on
        # this tick; the actual success/failure will be reported via
        # `request_upgrade_restart` (success) or queued
        # ``UPDATE_FAILED`` events (failure) once the worker finishes.
        return UpdateAttemptResult(
            attempted=True,
            succeeded=None,
            reason="upgrade subprocess dispatched (running off-thread)",
            target_version=target,
            extra={"in_progress": True, "method": method.value},
        )

    def _apply_via_worker(
        self,
        info: WatcherUpdateInfoResponse,
        method: InstallMethod,
        target: str,
    ) -> UpdateAttemptResult:
        """Dispatch an upgrade through the SYSTEM-owned scheduled task.

        Used on Windows uv-tool installs where the in-process
        ``uv tool install --reinstall`` cannot complete because it
        would need to delete ``Scripts\\python.exe`` while it's
        mapped into the running service. The worker stops the service
        first, runs ``uv``, then starts the service again — we just
        write the request sentinel and trigger the task.

        Pre-flight failures (no ``uv`` on disk, ``schtasks`` refuses
        the trigger) are surfaced as ``UPDATE_FAILED`` events with no
        preceding ``UPDATE_STARTED`` so the dashboard doesn't show a
        ghost in-flight upgrade. The success / final-failure events
        are emitted from the post-restart marker evaluation in
        :mod:`data_hub_watcher.runtime`, which reads the result
        sentinel the worker drops on disk.
        """
        # Lazy import keeps non-Windows test runs from importing the
        # scheduled-task wrapper (which itself is import-safe today
        # but might pull in win32 helpers later).
        from data_hub_watcher.scheduled_task import (
            ScheduledTaskError,
            trigger_upgrade_task,
        )

        uv_path, candidates = _resolve_uv_executable()
        if uv_path is None:
            reason = "uv executable not found"
            logger.warning("Refusing auto-update via worker: %s", reason)
            self._emit_failure(
                target,
                reason,
                extra={
                    "install_method": method.value,
                    "attempted_subprocess": False,
                    "via_worker": True,
                    "candidates_tried": candidates,
                },
            )
            return UpdateAttemptResult(True, False, reason, target, {"method": method.value})

        extras = detect_installed_extras()
        try:
            pkg_spec = build_pkg_spec(method, target_version=target, extras=extras)
        except ValueError as exc:
            # Defensive — we already filtered EDITABLE / UNKNOWN above.
            self._emit_failure(
                target,
                f"could not build pkg spec: {exc}",
                extra={"install_method": method.value, "attempted_subprocess": False},
            )
            return UpdateAttemptResult(True, False, str(exc), target)

        details_started: dict[str, Any] = {
            "current_version": WATCHER_VERSION,
            "target_version": target,
            "mandatory": info.mandatory,
            "install_method": method.value,
            "via_worker": True,
            "pkg_spec": pkg_spec,
        }
        self._reporter.queue_event(
            WatcherEvent(
                event_type=EventType.UPDATE_STARTED,
                message=f"Dispatching upgrade {WATCHER_VERSION} -> {target} via worker",
                details=details_started,
            )
        )
        # Flush before triggering so the dashboard sees the start
        # even if the service is stopped almost immediately by the
        # worker (the heartbeat loop doesn't get another chance to
        # flush before SCM tears it down).
        self._reporter.flush()

        write_upgrade_marker(
            self._config_dir,
            target_version=target,
            previous_version=WATCHER_VERSION,
        )
        write_upgrade_request(
            self._config_dir,
            target_version=target,
            pkg_spec=pkg_spec,
            uv_executable=uv_path,
            index_url=DEFAULT_INDEX_URL,
            previous_version=WATCHER_VERSION,
            install_method=method.value,
        )

        try:
            trigger_upgrade_task()
        except ScheduledTaskError as exc:
            # ``schtasks`` refused — most commonly because the task
            # isn't registered (fleet PC that auto-updated into the
            # worker-aware code without re-running ``service install``).
            # Clear our own sentinels so the next tick can try again
            # from a clean slate, and surface the failure with a
            # specific reason that points at the recovery command.
            logger.warning("schtasks /Run failed: %s", exc)
            clear_upgrade_marker(self._config_dir)
            from data_hub_watcher.upgrade_worker import clear_upgrade_request

            clear_upgrade_request(self._config_dir)
            self._emit_failure(
                target,
                "scheduled task could not be triggered; "
                "run 'data-hub-watcher service reinstall' as Administrator",
                extra={
                    "install_method": method.value,
                    "attempted_subprocess": False,
                    "via_worker": True,
                    "schtasks_argv": exc.argv,
                    "schtasks_stderr": exc.stderr,
                    "schtasks_returncode": exc.returncode,
                    "error_class": type(exc).__name__,
                },
            )
            return UpdateAttemptResult(
                True,
                False,
                "scheduled task trigger failed",
                target,
                {"method": method.value, "via_worker": True},
            )

        # The worker stops the service before invoking ``uv``, so we
        # don't expect to be alive much longer. The success /
        # final-failure event is emitted from the next process's
        # post-restart marker evaluation. We do NOT call
        # ``_request_upgrade_restart`` here — the worker drives the
        # service lifecycle (Stop-Service then Start-Service)
        # directly via ``schtasks``, bypassing SCM's failure-actions
        # restart path entirely.
        return UpdateAttemptResult(
            attempted=True,
            succeeded=None,
            reason="upgrade dispatched to scheduled task",
            target_version=target,
            extra={"method": method.value, "via_worker": True},
        )

    def _emit_failure(
        self,
        target: str,
        reason: str,
        *,
        extra: dict[str, Any] | None = None,
    ) -> None:
        details: dict[str, Any] = {
            "current_version": WATCHER_VERSION,
            "target_version": target,
            "reason": reason,
        }
        if extra:
            details.update(extra)
        self._reporter.queue_event(
            WatcherEvent(
                event_type=EventType.UPDATE_FAILED,
                message=f"Watcher upgrade to {target} failed: {reason}",
                details=details,
            )
        )
        # Drop the marker so a failed in-process upgrade doesn't pollute
        # the next startup with a misleading "expected X, running Y"
        # event — we already reported it here.
        clear_upgrade_marker(self._config_dir)
        self._reporter.flush()

    def _note_update_check_failure(self, error: str) -> None:
        """Bump the consecutive-failure counter and emit on the 3rd miss.

        Update checks run roughly hourly, so 3 consecutive failures
        represents ~3 hours of going dark on the update channel — long
        enough to indicate a real problem (network ACL, server bug)
        but short enough to flag mandatory rollouts before they're
        meaningfully delayed. Emitting on the 1st failure would alert
        on routine API blips that auto-recover on the next hour.
        """
        self._consecutive_update_check_failures += 1
        if self._consecutive_update_check_failures == 3:
            self._reporter.report_error(
                "update_check_failed",
                (
                    "Update check failed for "
                    f"{self._consecutive_update_check_failures} consecutive attempts: "
                    f"{error}"
                ),
                error=error,
                consecutive_failures=self._consecutive_update_check_failures,
            )

    def _last_run_age_seconds(self) -> float | None:
        ts = self._state_db.last_run_reported_at()
        if ts is None:
            return None
        try:
            t = datetime.fromisoformat(ts)
        except ValueError:
            return None
        if t.tzinfo is None:
            t = t.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - t).total_seconds()


__all__ = [
    "DEFAULT_CHECK_INTERVAL_TICKS",
    "DEFAULT_IDLE_TICKS_REQUIRED",
    "DEFAULT_RUN_QUIET_MULTIPLIER",
    "HEARTBEAT_INTERVAL_SECONDS",
    "UPGRADE_MARKER_FILENAME",
    "UpdateAttemptResult",
    "Updater",
    "UpdaterConfig",
    "UpgradeMarkerOutcome",
    "clear_upgrade_marker",
    "evaluate_upgrade_marker",
    "should_attempt_update",
    "upgrade_marker_path",
    "write_upgrade_marker",
]
