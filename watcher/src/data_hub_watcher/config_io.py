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
    except UnicodeDecodeError as exc:
        # Windows PowerShell 5.1 writes UTF-16 for `>` and `Out-File`, and some editors save in
        # a Windows code page, so a hand-edited config may not be UTF-8.
        raise click.ClickException(
            f"Cannot read config file {path}: it is not valid UTF-8 ({exc.reason} at byte "
            f"{exc.start}). Save it as UTF-8, not UTF-16 or a Windows code page."
        ) from exc
    except OSError as exc:
        raise click.ClickException(f"Cannot read config file: {exc}") from exc

    try:
        data = yaml.safe_load(raw)
    except yaml.YAMLError as exc:
        raise click.ClickException(f"Malformed YAML in {path}:\n{exc}") from exc

    if not isinstance(data, dict):
        raise click.ClickException(f"Expected a YAML mapping in {path}, got {type(data).__name__}")

    try:
        # `model_validate`, not `WatcherConfig(**data)`: a top-level key that isn't a string
        # (`1:`, `on:` and `yes:` are not strings in YAML) would make the call raise TypeError.
        return WatcherConfig.model_validate(data)
    except ValidationError as exc:
        errors = exc.errors()
        lines = [f"Config validation failed ({len(errors)} error(s)):"]
        for err in errors:
            loc = " → ".join(str(line) for line in err["loc"])
            lines.append(f"  • {loc}: {err['msg']}")
        raise click.ClickException("\n".join(lines)) from exc


def save_config(
    config: WatcherConfig, path: Path, *, watch_directory_text: str | None = None
) -> None:
    """Serialize *config* to YAML and write to *path*.

    *watch_directory_text* replaces the resolved folder in the file. A config
    revision from the web app passes the folder as the admin typed it, so the
    YAML pushed back afterwards matches the revision. The server treats
    different slashes, letter case and trailing separators as the same
    folder, but not a path that resolves elsewhere, such as a mapped drive
    that resolves to a UNC path or a symlink, and would record the resolved
    form as a new edit. Loading the file resolves the folder again.
    """
    path.parent.mkdir(parents=True, exist_ok=True)

    data = config.model_dump(mode="python")
    _convert_paths(data)
    if watch_directory_text is not None:
        data["instrument"]["watch_directory"] = watch_directory_text

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
