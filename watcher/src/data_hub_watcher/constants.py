from __future__ import annotations

import os
from pathlib import Path

API_URLS: dict[str, str] = {
    "staging": "https://data-hub-staging.arcadiascience.com/api/v1",
    "production": "https://data-hub.arcadiascience.com/api/v1",
}

S3_BUCKET_TEMPLATE = "arcadia-raw-data-hub-{environment}"

DEFAULT_CONFIG_DIR = Path("~/.data-hub").expanduser()
DEFAULT_CONFIG_FILENAME = "config.yaml"

HEARTBEAT_INTERVAL_SECONDS = 60
DEFAULT_STABILITY_PERIOD_SECONDS = 5
DEFAULT_PREFIX_PATTERN = r"^([^_]+)"

CONFIG_PATH_ENV_VAR = "DATA_HUB_CONFIG_PATH"


def resolve_config_path(cli_override: str | None = None) -> Path:
    """Return the config file path, checking CLI flag, env var, then default."""
    if cli_override:
        return Path(cli_override).expanduser()

    env_path = os.environ.get(CONFIG_PATH_ENV_VAR)
    if env_path:
        return Path(env_path).expanduser()

    return DEFAULT_CONFIG_DIR / DEFAULT_CONFIG_FILENAME
