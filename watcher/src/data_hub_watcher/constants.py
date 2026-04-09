from __future__ import annotations
import os
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
# Captures everything before the first underscore as the run ID,
# e.g. "RUN001_data.csv" → group(1) = "RUN001".
DEFAULT_PREFIX_PATTERN = r"^([^_]+)"

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
    """Persist *api_key* to ``~/.data-hub/.env`` and return the file path."""
    env_path = DEFAULT_CONFIG_DIR / ENV_FILENAME
    env_path.parent.mkdir(parents=True, exist_ok=True)
    env_path.write_text(f"DATA_HUB_API_KEY={api_key}\n", encoding="utf-8")
    return env_path


def resolve_config_path(cli_override: str | None = None) -> Path:
    """Return the config file path, checking CLI flag, env var, then default."""
    if cli_override:
        return Path(cli_override).expanduser()

    env_path = os.environ.get(CONFIG_PATH_ENV_VAR)
    if env_path:
        return Path(env_path).expanduser()

    return DEFAULT_CONFIG_DIR / DEFAULT_CONFIG_FILENAME
