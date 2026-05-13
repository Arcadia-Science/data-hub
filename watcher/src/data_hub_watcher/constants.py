from __future__ import annotations
import os
import re
import sys
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

from dotenv import load_dotenv

API_URLS: dict[str, str] = {
    "staging": "https://data-hub-env-staging-arcadia-science.vercel.app/api/v1",
    "production": "https://data-hub.arcadiascience.com/api/v1",
}


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
DEFAULT_STABILITY_PERIOD_SECONDS = 5

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


def resolve_config_path(cli_override: str | None = None) -> Path:
    """Return the config file path, checking CLI flag, env var, then default."""
    if cli_override:
        return Path(cli_override).expanduser()

    env_path = os.environ.get(CONFIG_PATH_ENV_VAR)
    if env_path:
        return Path(env_path).expanduser()

    return DEFAULT_CONFIG_DIR / DEFAULT_CONFIG_FILENAME
