from __future__ import annotations
import os
import re
import sys
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

from dotenv import load_dotenv


def _read_watcher_version() -> str:
    # Resolve the installed distribution version once at import time so the
    # value can be embedded in heartbeats. When the watcher is being run from
    # an editable checkout outside its own metadata (e.g. some test contexts)
    # the dist may not be importable; fall back to a sentinel rather than
    # crashing the heartbeat loop.
    try:
        return version("data-hub-watcher")
    except PackageNotFoundError:
        return "0.0.0+unknown"


WATCHER_VERSION: str = _read_watcher_version()

# Sent on every API request. The server uses it to keep older watchers on
# the behavior they were built for. Missing on watchers before 1.1.0.
WATCHER_VERSION_HEADER = "X-Data-Hub-Watcher-Version"

DEFAULT_CONFIG_DIR = Path("~/.data-hub").expanduser()
DEFAULT_CONFIG_FILENAME = "config.yaml"
ENV_FILENAME = ".env"


def _resolve_watcher_log_dir() -> Path:
    """Pick a log directory that both the operator user and LocalSystem can write to.

    On Windows, ``~/.data-hub`` expands to different paths depending on
    the account running the process — ``C:\\Users\\<op>\\.data-hub`` for
    the operator running the CLI, ``C:\\Windows\\System32\\config\\
    systemprofile\\.data-hub`` for the LocalSystem account the service
    runs as. That split means a tail of "the" log file shows only half
    the story during a triage session. We instead anchor logs at
    ``C:\\ProgramData\\DataHubWatcher`` (the conventional Windows
    location for cross-user app data), where both accounts have write
    access by default.

    On non-Windows we keep ``DEFAULT_CONFIG_DIR`` so dev/test runs on
    macOS or Linux still write under the working tree's ``~/.data-hub``
    rather than trying to create a Windows-only path.

    The exact filename (``watcher.log``) is shared by the CLI ``watch``
    command and the Windows service. Running both simultaneously on
    the same host is not supported — see the troubleshooting guide for
    why — so the shared-file rotation race is not a real concern in
    operator deployments.
    """
    if sys.platform == "win32":
        # ``os.environ.get(name, default)`` returns the empty string
        # when ``name`` is set to ``""`` rather than falling back to
        # the default. Guard against that by treating an empty value
        # as missing — otherwise ``Path("") / "DataHubWatcher"`` would
        # silently produce a relative path that lands in whatever
        # cwd the service happens to start from.
        program_data = os.environ.get("ProgramData") or r"C:\ProgramData"
        return Path(program_data) / "DataHubWatcher"
    return DEFAULT_CONFIG_DIR


WATCHER_LOG_DIR = _resolve_watcher_log_dir()
SUPPORTED_ENVIRONMENTS: tuple[str, ...] = ("staging", "production", "preview")

HEARTBEAT_INTERVAL_SECONDS = 60
# The `status_reason` on the final `stopped` heartbeat when the stop was caused by
# Windows shutting down or restarting. A server that knows the value keeps the
# instrument's requested uploads queued, for the watcher to upload after the PC
# starts again. The server's `SYSTEM_SHUTDOWN_STATUS_REASON` must say the same.
SYSTEM_SHUTDOWN_STATUS_REASON = "system_shutdown"
# A normal stop (Ctrl+C or SIGTERM for `watch`, `service stop`, a restart for an update)
# finishes within `STOP_BUDGET_SECONDS`, even when the server stops answering. Uploads
# still running and a heartbeat in progress get the time before the last
# `STOP_RESERVE_SECONDS`. Whatever is still running then is given up: uploads are cut off
# (`Uploader.abort`) and a heartbeat in progress is left behind. The reserve is for the
# `watcher_stopped` event, and then the final heartbeat, which gets the last
# `STOP_FINAL_HEARTBEAT_SECONDS` so a slow flush can't starve it. Each of those two
# requests has the client's usual HTTP timeout (`DEFAULT_TIMEOUT` in `api_client`, 5 s to
# connect and 30 s to read), cut down to fit the time it has, so a server that answers
# slowly still gets them. In auto mode an upload that was cut off is uploaded again at
# the next start, from its `pending_uploads` row. A file that someone requested is not:
# a plain `stopped` heartbeat makes the server cancel the instrument's requested
# uploads, so it has to be requested again. Only a final heartbeat marked as a restart
# keeps them queued: `SYSTEM_SHUTDOWN_STATUS_REASON` for Windows restarting, and
# `auto_update` for an update once the watcher sends it (`RESTART_STOP_REASONS` in
# `web/lib/api/watcher-status.ts`). The service loop sees a stop as soon as it is set,
# unless it is busy with config work, and the SCM is told to wait
# `SERVICE_STOP_WAIT_HINT_MILLISECONDS`.
STOP_BUDGET_SECONDS = 25
STOP_RESERVE_SECONDS = 10
STOP_FINAL_HEARTBEAT_SECONDS = 5
# The least a join gets in a stop that has run out of time: after the uploads are cut off,
# and for a heartbeat in progress.
STOP_MIN_WAIT_SECONDS = 1
SERVICE_STOP_WAIT_HINT_MILLISECONDS = 30_000
# Windows waits for the service to stop, at a restart or a shutdown, for the
# preshutdown timeout: 10 s by default from Windows 10 build 15063 and 180 s
# before it. A stop for Windows shutting down limits itself to about 8 s on any
# build, so it can't hold the restart up. It is 7 s for the stop itself, which
# starts as soon as the service loop sees the stop (not while the loop is busy with
# config work), and a moment for the process to end. It is the same sequence as any
# other stop, with much shorter waits: uploads are cut off first (`Uploader.abort`),
# each of the four joins (file monitor's observer and stability checker, upload
# worker, a heartbeat in progress) takes at most 1 s, and the events and the final
# heartbeat share what is left of the 7 s, each request with a connect timeout of at
# most 2 s and a read timeout of at most 3 s. A file whose upload was cut off is
# uploaded again at the next start, as after any other stop. A file someone
# requested stays queued, because the final heartbeat is marked as a restart.
SYSTEM_SHUTDOWN_STOP_BUDGET_SECONDS = 7
SYSTEM_SHUTDOWN_JOIN_SECONDS = 1
SYSTEM_SHUTDOWN_HTTP_TIMEOUT: tuple[float, float] = (2, 3)  # (connect, read) seconds
# Kept separate from ``HEARTBEAT_INTERVAL_SECONDS`` so the poll cadence can
# diverge now that uploads no longer ride the heartbeat tick.
UPLOAD_POLL_INTERVAL_SECONDS = 60
# How long applying a config revision from the web app waits for uploads in
# progress before rebuilding the runtime. The stop starts no new file or part
# and lets the PUTs already sending finish: up to `upload_parallelism` whole
# files or 64 MB parts. A file that didn't finish, such as a large file that
# still had parts to send, keeps its `pending_uploads` row or stays in the
# server's queue: a rebuild sends no `stopped` heartbeat, so the server doesn't
# cancel the request. Past the limit the uploader cuts off the PUTs and hashing
# still running, and the rebuild waits for their threads to exit before it
# starts the new runtime.
CONFIG_APPLY_DRAIN_TIMEOUT_SECONDS = 120
# While waiting with the watch folder present, a start that keeps failing is
# retried after 1, 2, 4 and 8 heartbeat intervals, then every 15 minutes, so a
# persistent failure doesn't rebuild the runtime and log a traceback every
# minute. A missing folder is still checked on every heartbeat.
WAITING_START_RETRY_MAX_SECONDS = 15 * 60
DEFAULT_STABILITY_PERIOD_SECONDS = 5

# Auto-update cadence, counted in heartbeat ticks. With a 60-second heartbeat
# this works out to roughly "5 minutes idle before we even consider an update"
# and "one update check per hour". Both are deliberately conservative: we'd
# rather miss an update window than interrupt a running experiment.
DEFAULT_IDLE_TICKS_REQUIRED = 5
DEFAULT_CHECK_INTERVAL_TICKS = 60

# Default index for `pip install` / `uv tool install` invocations.
DEFAULT_INDEX_URL = "https://pypi.org/simple/"

# Built-in presets for the ``init`` / ``config edit`` wizard.
# Each entry: (key, description, pattern, recursive_default).
# The stored config always uses a raw ``pattern`` + ``recursive``; these
# presets exist purely as convenience shortcuts for operators.
RUN_DETECTION_PRESETS: list[tuple[str, str, str, bool]] = [
    (
        "filename_prefix",
        "Run ID is the filename prefix (before the first underscore)",
        r"^([^_]+)",
        False,
    ),
    (
        "top_subdirectory",
        "Each top-level subdirectory is a run",
        r"^([^/]+)/",
        True,
    ),
    (
        "deepest_subdirectory",
        "The deepest subdirectory (immediate parent of the file) is a run",
        r"([^/]+)/[^/]+$",
        True,
    ),
    (
        "timestamp_subdirectory",
        "Timestamp-named subdirectory (YYYYMMDD_HHMMSS_fff) is a run",
        r"(?:^|/)(\d{8}_\d{6}_\d{3})/",
        True,
    ),
    (
        "filename_stem",
        "Each file is its own run (run ID = filename without extension)",
        r"^(?:.+/)?([^/]+?)\.[^/.]+$",
        False,
    ),
]

# If a file keeps changing for longer than this, give up and skip it
# (likely being continuously appended to or locked by another process).
MAX_STABILITY_WAIT_SECONDS = 300
UPLOAD_RETRY_MAX = 3
UPLOAD_RETRY_BASE_DELAY = 1
# How many upload-queue polls re-attempt the same queued file (missing or
# failing to upload) before the watcher gives up and cancels the request
# server-side. Distinct from `UPLOAD_RETRY_MAX` (per-upload S3 PUT retries).
# ~3 min at the 60s poll: long enough to ride out a blip, short enough that
# a stale entry from a dir change self-clears.
MAX_QUEUE_FILE_ATTEMPTS = 3
# How many watcher starts retry an auto-mode upload that never finished.
# After that the file waits for someone to request it from the run page.
MAX_PENDING_UPLOAD_ATTEMPTS = 3
# A run report that fails with a connection error or a 5xx is retried until it
# succeeds, so a single-file run isn't stranded until the next restart. The
# delay doubles from the base, then stays at the cap.
RUN_REPORT_RETRY_BASE_DELAY_SECONDS = 5
RUN_REPORT_RETRY_MAX_DELAY_SECONDS = 300
# Upload records older than this are pruned from the local state DB
# to prevent unbounded growth on long-running watcher instances.
PRUNE_DAYS = 90
STATE_DB_FILENAME = "watcher.db"
SERVICE_NAME = "DataHubWatcher"

CONFIG_PATH_ENV_VAR = "DATA_HUB_CONFIG_PATH"


def env_file_path(environment: str | None = None) -> Path:
    """Return the env file path for *environment* (or the base file if ``None``).

    Examples:
        ``env_file_path()``           -> ``~/.data-hub/.env``
        ``env_file_path("staging")``  -> ``~/.data-hub/.env.staging``
    """
    if environment:
        return DEFAULT_CONFIG_DIR / f"{ENV_FILENAME}.{environment}"
    return DEFAULT_CONFIG_DIR / ENV_FILENAME


def load_env(environment: str | None = None) -> None:
    """Load env files from ``~/.data-hub/`` into the process environment.

    Always loads the base ``.env`` first. If *environment* is provided,
    overlays ``.env.<environment>`` on top so its values take precedence.
    Existing process-level environment variables (e.g. an explicit
    ``DATA_HUB_API_KEY`` export) still win over the base file but are
    overridden by the env-specific file when one is supplied — this lets
    operators switch environments simply by changing the config without
    re-exporting their key.
    """
    load_dotenv(env_file_path())
    if environment:
        load_dotenv(env_file_path(environment), override=True)


def save_api_key(api_key: str, environment: str | None = None) -> Path:
    """Persist *api_key* to the env file for *environment* and return its path.

    When *environment* is provided the key is written to
    ``~/.data-hub/.env.<environment>`` so each deployment target keeps its
    own credentials. Without *environment* the legacy ``~/.data-hub/.env``
    file is used.

    Preserves any other variables already present in the file and
    single-quotes the value to guard against special characters
    (``#``, ``=``, whitespace) that would confuse dotenv parsers.
    """
    env_path = env_file_path(environment)
    env_path.parent.mkdir(parents=True, exist_ok=True)

    key_line = f"DATA_HUB_API_KEY='{api_key}'\n"
    _KEY_RE = re.compile(r"^DATA_HUB_API_KEY=")

    if env_path.exists():
        lines = env_path.read_text(encoding="utf-8").splitlines(keepends=True)
        replaced = False
        new_lines: list[str] = []
        for line in lines:
            if _KEY_RE.match(line):
                new_lines.append(key_line)
                replaced = True
            else:
                new_lines.append(line)
        if not replaced:
            if new_lines and not new_lines[-1].endswith("\n"):
                new_lines.append("\n")
            new_lines.append(key_line)
        env_path.write_text("".join(new_lines), encoding="utf-8")
    else:
        env_path.write_text(key_line, encoding="utf-8")

    return env_path


# Sidecars SQLite creates alongside the main DB file in WAL mode; they must
# travel with it on rename and be removed on reset or the DB is left corrupt.
_SQLITE_SIDECAR_SUFFIXES: tuple[str, ...] = ("", "-wal", "-shm")


def state_db_path(config_dir: Path, environment: str) -> Path:
    """Per-environment state DB path.

    Keyed by `environment` (not `watcher_id`) so a deregister/re-register on
    the same host reuses the existing dedup history instead of re-uploading
    the whole backlog. See `docs/developer/watcher.md` for the rationale.
    """
    return config_dir / f"watcher-{environment}.db"


def state_db_dir(config_path: Path, *, service: bool) -> Path:
    """Directory of the state DB a running watcher opens for *config_path*.

    The Windows service keeps it beside its registry-stored config. `watch`
    and `upload` use `DEFAULT_CONFIG_DIR` even with `--config`, so a command
    that edits state has to check both.
    """
    return config_path.parent if service else DEFAULT_CONFIG_DIR


def resolve_state_db_path(config_dir: Path, environment: str) -> Path:
    """Return the per-environment state DB path, migrating the legacy file once.

    The pre-multi-env single `watcher.db` belongs to whatever environment was
    active before the upgrade, i.e. the one being resolved now. Renaming it
    (rather than starting fresh) preserves that environment's dedup state so
    the first post-upgrade scan does not re-upload everything.
    """
    target = state_db_path(config_dir, environment)
    legacy = config_dir / STATE_DB_FILENAME
    if not target.exists() and legacy.exists():
        for suffix in _SQLITE_SIDECAR_SUFFIXES:
            src = legacy.with_name(legacy.name + suffix)
            if src.exists():
                src.rename(target.with_name(target.name + suffix))
    return target


def reset_state_db(config_dir: Path, environment: str) -> None:
    """Delete an environment's state DB (and WAL sidecars).

    Used when a preview deployment changes so the next start reseeds a clean
    baseline against the new target instead of inheriting the old one's state.
    """
    target = state_db_path(config_dir, environment)
    for suffix in _SQLITE_SIDECAR_SUFFIXES:
        target.with_name(target.name + suffix).unlink(missing_ok=True)


def resolve_config_path(cli_override: str | None = None) -> Path:
    """Return the config file path, checking CLI flag, env var, then default."""
    if cli_override:
        return Path(cli_override).expanduser()

    env_path = os.environ.get(CONFIG_PATH_ENV_VAR)
    if env_path:
        return Path(env_path).expanduser()

    return DEFAULT_CONFIG_DIR / DEFAULT_CONFIG_FILENAME
