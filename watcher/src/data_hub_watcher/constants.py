from __future__ import annotations
import os
import re
from pathlib import Path

from dotenv import load_dotenv

API_URLS: dict[str, str] = {
    "staging": "https://data-hub-env-staging-arcadia-science.vercel.app/api/v1",
    "production": "https://data-hub.arcadiascience.com/api/v1",
}

DEFAULT_CONFIG_DIR = Path("~/.data-hub").expanduser()
DEFAULT_CONFIG_FILENAME = "config.yaml"
ENV_FILENAME = ".env"

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


def load_env() -> None:
    """Load ``~/.data-hub/.env`` into the process environment.

    Existing environment variables take precedence (``override=False``),
    so an explicit ``DATA_HUB_API_KEY`` export still wins.
    """
    env_path = DEFAULT_CONFIG_DIR / ENV_FILENAME
    load_dotenv(env_path)


def save_api_key(api_key: str) -> Path:
    """Persist *api_key* to ``~/.data-hub/.env`` and return the file path.

    Preserves any other variables already present in the file and
    single-quotes the value to guard against special characters
    (``#``, ``=``, whitespace) that would confuse dotenv parsers.
    """
    env_path = DEFAULT_CONFIG_DIR / ENV_FILENAME
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
