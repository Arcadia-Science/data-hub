"""Shared logging configuration for the CLI and Windows-service entry points.

Both ``data-hub-watcher watch`` and the Windows service path need the same
rotating-file behavior so the troubleshooting guide can promise a single
log file regardless of how the watcher was launched. Historically only
the CLI wired up file logging; every ``logger.*`` call made from the
service path was silently dropped — see the long comment on
``setup_file_logging`` for the gory details.

This module is platform-independent. The ``servicemanager`` integration
takes an already-imported module via :func:`attach_servicemanager_handler`
so that it can be patched out in unit tests on non-Windows hosts.
"""

from __future__ import annotations
import logging
import os
import threading
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any

from data_hub_watcher.constants import WATCHER_LOG_DIR

LOG_FORMAT = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
LOG_FILENAME = "watcher.log"

# 32 KB is the per-string cap on a Windows Event Log entry. Leave a small
# margin so the level prefix + timestamp added by ``Formatter`` don't push
# us over the limit when we forward a long traceback.
_EVENT_LOG_MAX_BYTES = 30 * 1024

# Map a string level (case-insensitive) to a stdlib level. ``logging``
# already provides ``getLevelName`` for this but it returns a string for
# unknown inputs, which is not what we want — fall back to INFO instead
# so a typo in a lab PC's ``.env`` file doesn't silence everything.
_LEVEL_ENV_VAR = "DATA_HUB_WATCHER_LOG_LEVEL"


def _resolve_root_level(default: int = logging.INFO) -> int:
    """Resolve the root log level, honoring the ``DATA_HUB_WATCHER_LOG_LEVEL`` override.

    Lab operators can flip a stuck host to verbose logging by adding
    ``DATA_HUB_WATCHER_LOG_LEVEL=DEBUG`` to the registered env file and
    restarting the service — no redeploy required. Unknown values fall
    back to *default* rather than failing closed so a typo can't make
    the watcher silently log nothing.
    """
    raw = os.environ.get(_LEVEL_ENV_VAR)
    if not raw:
        return default
    level = logging.getLevelName(raw.upper())
    if isinstance(level, int):
        return level
    return default


def _apply_root_level() -> None:
    """Set the root logger level from the env var override if present.

    The watcher's two entrypoints (CLI ``watch`` and the Windows
    service) each call into this module once at startup. We only
    *force* the level when ``DATA_HUB_WATCHER_LOG_LEVEL`` is set —
    otherwise we either initialize the (still-unset) root logger to
    INFO, or leave a caller-supplied level alone. Without this
    deference, a user that explicitly set ``logging.DEBUG`` at the
    top of a script would have their choice silently reverted to
    INFO by the first ``setup_file_logging`` call.
    """
    raw = os.environ.get(_LEVEL_ENV_VAR)
    root = logging.getLogger()
    if raw:
        root.setLevel(_resolve_root_level())
        return
    if root.level == logging.NOTSET:
        root.setLevel(logging.INFO)


def _watcher_log_path() -> Path:
    return WATCHER_LOG_DIR / LOG_FILENAME


def setup_file_logging() -> Path:
    """Attach a rotating file handler at ``watcher.log`` to the root logger.

    Idempotent: if a ``RotatingFileHandler`` for the same path is already
    attached to the root logger, returns the existing path without
    adding a duplicate. This matters because both the CLI ``watch``
    command and the service path can call this — and on the service
    path it's called inside ``_run_service_loop``, which the SCM may
    re-invoke after a restart inside the same Python process.

    The path resolves to ``C:\\ProgramData\\DataHubWatcher\\watcher.log``
    on Windows (a location both the operator user and LocalSystem can
    write to) and ``~/.data-hub/watcher.log`` on non-Windows hosts; see
    :data:`data_hub_watcher.constants.WATCHER_LOG_DIR` for the
    rationale. Running ``data-hub-watcher watch`` while the service is
    also running is not supported — both processes would race on the
    same rotating file — but neither is running two watchers against
    the same instrument, so this is not a new constraint.
    """
    log_path = _watcher_log_path()
    log_path.parent.mkdir(parents=True, exist_ok=True)

    _apply_root_level()
    root = logging.getLogger()

    target = str(log_path)
    for existing in root.handlers:
        if isinstance(existing, RotatingFileHandler) and getattr(
            existing, "baseFilename", None
        ) == str(log_path.resolve(strict=False)):
            return log_path
        # ``baseFilename`` is always absolute on RotatingFileHandler,
        # but the resolved path comparison above may miss handlers
        # registered with a non-canonicalized path on Windows. Fall
        # back to a case-insensitive string compare on Windows to
        # avoid double-registering.
        if (
            isinstance(existing, RotatingFileHandler)
            and getattr(existing, "baseFilename", "").lower() == target.lower()
        ):
            return log_path

    handler = RotatingFileHandler(
        target, maxBytes=10 * 1024 * 1024, backupCount=5, encoding="utf-8"
    )
    handler.setFormatter(logging.Formatter(LOG_FORMAT))
    root.addHandler(handler)
    return log_path


class _ServiceManagerHandler(logging.Handler):
    """Forward log records to ``servicemanager.Log*Msg`` so they reach the Windows Event Log.

    Routing is by record level:

      * ``ERROR`` / ``CRITICAL`` -> ``LogErrorMsg``
      * ``WARNING``              -> ``LogWarningMsg``
      * everything else          -> ``LogInfoMsg``

    Two important safety properties:

    1. Re-entrancy guard. If ``LogErrorMsg`` itself raises (e.g. the
       Event Log service is unreachable), the exception is caught by
       ``logging.Handler.handleError`` — which, depending on the
       configured ``logging.raiseExceptions`` flag, may attempt to log
       the failure through the root logger. That would route back
       through *this* handler and loop. We guard with a per-thread
       flag so re-entry is a no-op.
    2. Truncation. Event Log entries are capped at 32 KB per string.
       We truncate the formatted message at 30 KB to leave headroom
       for the level prefix the SCM may add, with a clear ``[truncated]``
       marker so an operator reading the event log knows the rest is
       in ``watcher.log``.
    """

    def __init__(self, sm: Any) -> None:
        super().__init__()
        self._sm = sm
        self._local = threading.local()

    def emit(self, record: logging.LogRecord) -> None:
        if getattr(self._local, "in_emit", False):
            return
        self._local.in_emit = True
        try:
            try:
                msg = self.format(record)
            except Exception:
                # Mirrors logging.Handler.emit's standard fallback.
                self.handleError(record)
                return

            if len(msg) > _EVENT_LOG_MAX_BYTES:
                msg = (
                    msg[:_EVENT_LOG_MAX_BYTES]
                    + f"\n... [truncated; see {LOG_FILENAME} for full message]"
                )

            try:
                if record.levelno >= logging.ERROR:
                    self._sm.LogErrorMsg(msg)
                elif record.levelno >= logging.WARNING:
                    self._sm.LogWarningMsg(msg)
                else:
                    self._sm.LogInfoMsg(msg)
            except Exception:
                # Never raise out of a log call — the worst case is a
                # missing Event Log entry, not a crashed service.
                self.handleError(record)
        finally:
            self._local.in_emit = False


def attach_servicemanager_handler(sm: Any) -> _ServiceManagerHandler:
    """Attach a :class:`_ServiceManagerHandler` for *sm* to the root logger.

    Idempotent: if a handler is already attached for the same *sm*
    object, the existing handler is returned unchanged. Callers should
    typically invoke this exactly once at service startup, immediately
    after :func:`setup_file_logging`, so every subsequent ``logger.*``
    call from the watcher's library code reaches both the rotating
    file log AND the Windows Event Log.
    """
    _apply_root_level()
    root = logging.getLogger()

    for existing in root.handlers:
        if isinstance(existing, _ServiceManagerHandler) and existing._sm is sm:
            return existing

    handler = _ServiceManagerHandler(sm)
    handler.setFormatter(logging.Formatter(LOG_FORMAT))
    root.addHandler(handler)
    return handler
