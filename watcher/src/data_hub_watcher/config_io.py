from __future__ import annotations
import hashlib
from pathlib import Path

import click
import yaml
from pydantic import ValidationError

from data_hub_watcher.constants import DEFAULT_CONFIG_DIR
from data_hub_watcher.models import WatcherConfig


def ensure_config_dir() -> Path:
    """Create `~/.data-hub/` if it does not exist and return the path."""
    DEFAULT_CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    return DEFAULT_CONFIG_DIR


def load_config(path: Path) -> WatcherConfig:
    """Read *path* as YAML and return a validated `WatcherConfig`."""
    if not path.exists():
        raise click.ClickException(f"Config file not found: {path}")

    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise click.ClickException(f"Cannot read config file: {exc}") from exc

    try:
        data = yaml.safe_load(raw)
    except yaml.YAMLError as exc:
        raise click.ClickException(f"Malformed YAML in {path}:\n{exc}") from exc

    if not isinstance(data, dict):
        raise click.ClickException(f"Expected a YAML mapping in {path}, got {type(data).__name__}")

    try:
        return WatcherConfig(**data)
    except ValidationError as exc:
        errors = exc.errors()
        lines = [f"Config validation failed ({len(errors)} error(s)):"]
        for err in errors:
            loc = " → ".join(str(line) for line in err["loc"])
            lines.append(f"  • {loc}: {err['msg']}")
        raise click.ClickException("\n".join(lines)) from exc


def save_config(config: WatcherConfig, path: Path) -> None:
    """Serialize *config* to YAML and write to *path*."""
    path.parent.mkdir(parents=True, exist_ok=True)

    data = config.model_dump(mode="python")
    _convert_paths(data)

    raw = yaml.dump(data, default_flow_style=False, sort_keys=False, allow_unicode=True)
    path.write_text(raw, encoding="utf-8")


def config_checksum(path: Path) -> str:
    """Return `sha256:<hex>` digest of the config file contents."""
    contents = path.read_bytes()
    digest = hashlib.sha256(contents).hexdigest()
    return f"sha256:{digest}"


def _convert_paths(obj: object) -> None:
    """Recursively convert `Path` values to strings for YAML serialization."""
    if isinstance(obj, dict):
        for key in list(obj.keys()):
            val = obj[key]
            if isinstance(val, Path):
                obj[key] = str(val)
            else:
                _convert_paths(val)
    elif isinstance(obj, list):
        for i, val in enumerate(obj):
            if isinstance(val, Path):
                obj[i] = str(val)
            else:
                _convert_paths(val)
