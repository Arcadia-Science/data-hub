"""Test-only environment-variable overrides for the watcher's built-in timers.

The end-to-end suite runs the real watcher, whose timers are minutes long
(a 60-second heartbeat, an hourly update check, ...). These variables let the
suite shrink them, and point self-update at a local package index, without
patching code in the process under test. They are not an operator feature and
are documented only in ``docs/developer/watcher.md``.

Two rules keep them safe to ship:

* They are read when a value is needed (when a runtime or a waiting state is
  built, or an upgrade is dispatched), never at import time. The Windows
  service loads its registered env file after this module is imported, so an
  import-time read would miss every value set there.
* With no variable set, every accessor returns the production default, so
  behavior is unchanged.

A bad value never stops a watcher. It logs a warning naming the variable and
the default is used instead. One warning per process lists every active
override, so a log from a PC with a test knob left set says so. The watcher
announces them when it starts (`announce_active_overrides`), and the first
accessor that applies one does too, for entry points that don't go through
that start, such as ``self-update``.

Keep this module free of imports from the rest of the package other than
``constants``: ``runtime``, ``updater``, ``self_update`` and ``cli`` all call
into it.
"""

from __future__ import annotations
import logging
import os
import re
import threading
from collections.abc import Callable
from urllib.parse import urlsplit

from data_hub_watcher.constants import (
    DEFAULT_CHECK_INTERVAL_TICKS,
    DEFAULT_IDLE_TICKS_REQUIRED,
    DEFAULT_INDEX_URL,
    HEARTBEAT_INTERVAL_SECONDS,
    UPLOAD_POLL_INTERVAL_SECONDS,
)

logger = logging.getLogger(__name__)

HEARTBEAT_INTERVAL_ENV_VAR = "DATA_HUB_WATCHER_HEARTBEAT_INTERVAL_SECONDS"
UPLOAD_POLL_INTERVAL_ENV_VAR = "DATA_HUB_WATCHER_UPLOAD_POLL_INTERVAL_SECONDS"
UPDATE_CHECK_INTERVAL_TICKS_ENV_VAR = "DATA_HUB_WATCHER_UPDATE_CHECK_INTERVAL_TICKS"
UPDATE_IDLE_TICKS_ENV_VAR = "DATA_HUB_WATCHER_UPDATE_IDLE_TICKS"
INDEX_URL_ENV_VAR = "DATA_HUB_WATCHER_INDEX_URL"

# An interval in seconds ends up as a ``threading.Event.wait`` timeout, which
# raises OverflowError for very large values (``threading.TIMEOUT_MAX``, which
# is lower on Windows). A day is far past anything a test needs and far below
# that, so a typo can't kill the heartbeat or upload thread.
_MAX_SECONDS = 24 * 60 * 60

# Ticks are only compared, never waited on, so the limit is just a length that
# keeps ``int`` from ever hitting its size limit. The pattern accepts ASCII
# digits only (no sign, decimal point, underscore or other script's digits) and
# no more than ``_MAX_DIGITS`` of them, and the tick cap is the largest number
# that length can hold, so the two can't drift apart.
_MAX_DIGITS = 9
_MAX_TICKS = 10**_MAX_DIGITS - 1
_DIGITS = re.compile(rf"[0-9]{{1,{_MAX_DIGITS}}}")


def _check_whole_number(value: str, *, maximum: int) -> str | None:
    """Return what is wrong with *value* as a whole number from 1 to *maximum*."""
    if _DIGITS.fullmatch(value) is None or not 1 <= int(value) <= maximum:
        return f"expected a whole number from 1 to {maximum}"
    return None


def _check_seconds(value: str) -> str | None:
    return _check_whole_number(value, maximum=_MAX_SECONDS)


def _check_ticks(value: str) -> str | None:
    return _check_whole_number(value, maximum=_MAX_TICKS)


def _check_index_url(value: str) -> str | None:
    """Return what is wrong with *value* as a package index URL.

    The URL is handed to ``uv`` and ``pip`` as one argument. On Windows the
    upgrade worker passes it through ``Start-Process -ArgumentList``, which
    splits on whitespace, so a space would turn the tail into extra ``uv``
    arguments. It is also written to logs, the Windows Event Log and the
    ``UPDATE_FAILED`` event details, so a URL with a username or password would
    spread the credentials. A test index needs neither.
    """
    problem = "expected an http:// or https:// URL"
    try:
        parts = urlsplit(value)
    except ValueError:
        # For example an unclosed IPv6 bracket.
        return problem
    if parts.scheme not in ("http", "https") or not parts.netloc:
        return problem
    if any(char.isspace() or not char.isprintable() for char in value):
        return "a URL can't contain spaces or control characters"
    if "@" in parts.netloc:
        return "a URL can't contain a username or password"
    return None


# Each variable with the check that decides whether its value is usable.
_CHECKS: dict[str, Callable[[str], str | None]] = {
    HEARTBEAT_INTERVAL_ENV_VAR: _check_seconds,
    UPLOAD_POLL_INTERVAL_ENV_VAR: _check_seconds,
    UPDATE_CHECK_INTERVAL_TICKS_ENV_VAR: _check_ticks,
    UPDATE_IDLE_TICKS_ENV_VAR: _check_ticks,
    INDEX_URL_ENV_VAR: _check_index_url,
}

ALL_ENV_VARS: tuple[str, ...] = tuple(_CHECKS)

# Per-process state, guarded by ``_lock``: whether the active overrides have
# been announced, and which bad values have been reported.
_lock = threading.RLock()
_announced = False
_warned_invalid: set[tuple[str, str]] = set()


def heartbeat_interval_seconds() -> int:
    """Seconds between heartbeats, and the base of the start-failure backoff."""
    return _integer(HEARTBEAT_INTERVAL_ENV_VAR, HEARTBEAT_INTERVAL_SECONDS)


def upload_poll_interval_seconds() -> int:
    """Seconds between polls of the server's upload queue."""
    return _integer(UPLOAD_POLL_INTERVAL_ENV_VAR, UPLOAD_POLL_INTERVAL_SECONDS)


def update_check_interval_ticks() -> int:
    """Heartbeat ticks between ``/update-check`` calls."""
    return _integer(UPDATE_CHECK_INTERVAL_TICKS_ENV_VAR, DEFAULT_CHECK_INTERVAL_TICKS)


def update_idle_ticks() -> int:
    """Idle heartbeat ticks required before a non-mandatory update may install."""
    return _integer(UPDATE_IDLE_TICKS_ENV_VAR, DEFAULT_IDLE_TICKS_REQUIRED)


def index_url() -> str:
    """Package index that self-update installs from."""
    value = _validated(INDEX_URL_ENV_VAR)
    if value is None:
        return DEFAULT_INDEX_URL
    announce_active_overrides()
    return value


def announce_active_overrides() -> None:
    """Log one warning that lists every override set to a valid value.

    The watcher calls this when it starts, so a PC with a test setting left
    behind says so even when the setting is one that is only read much later,
    such as the package index. It also reports each value that is set but
    unusable. Does nothing when no override is active. After the first
    announcement the process doesn't make another, so it is safe to call from
    every entry point.
    """
    global _announced
    with _lock:
        if _announced:
            return
        active = _active_overrides()
        if not active:
            return
        _announced = True
    listing = ", ".join(f"{name}={value}" for name, value in active.items())
    logger.warning(
        "Test-only overrides are active, so this watcher's timers or package index "
        "differ from production: %s. Unset them on a real PC.",
        listing,
    )


def reset_warning_state() -> None:
    """Forget what has been warned about, so the next use warns again.

    For tests. In production the state lives as long as the process.
    """
    global _announced
    with _lock:
        _announced = False
        _warned_invalid.clear()


def _active_overrides() -> dict[str, str]:
    """The overrides that are set to a valid value, as ``{variable: value}``."""
    active: dict[str, str] = {}
    for name in ALL_ENV_VARS:
        value = _validated(name)
        if value is not None:
            active[name] = value
    return active


def _integer(name: str, default: int) -> int:
    value = _validated(name)
    if value is None:
        return default
    announce_active_overrides()
    return int(value)


def _validated(name: str) -> str | None:
    """Return *name*'s value when it is set and usable, else ``None``.

    An unset or blank variable is the same as no override and is not reported:
    ``NAME=`` in an env file is how a value gets cleared. A value that is set
    but unusable is reported once and then ignored.
    """
    value = os.environ.get(name, "").strip()
    if not value:
        return None
    problem = _CHECKS[name](value)
    if problem is None:
        return value
    with _lock:
        first_time = (name, value) not in _warned_invalid
        _warned_invalid.add((name, value))
    if first_time:
        logger.warning(
            "Ignoring %s=%s (%s); using the default.", name, _for_log(name, value), problem
        )
    return None


def _for_log(name: str, value: str) -> str:
    """*value* as the warning for an unusable value shows it.

    A package index URL can carry a username and password, and a rejected one
    would otherwise be copied into the log, the Windows Event Log and wherever
    those are shipped. When it holds an ``@``, it isn't shown.
    """
    if name == INDEX_URL_ENV_VAR and "@" in value:
        return "<hidden because it contains an @ and may hold credentials>"
    return repr(value)
