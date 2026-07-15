"""Build a machine-readable catalog of the watcher Click CLI.

The docs site renders its CLI reference from a committed snapshot of this
catalog, so help text and flags come straight from ``cli.py`` instead of
hand-maintained MDX tables. The tests here are smoke checks on the walker; they
don't guard the docs snapshot from going stale, since that copy lives in the
data-hub-docs repo and is refreshed manually via ``make py-watcher-cli-catalog``.
"""

from __future__ import annotations
import json
import sys
from pathlib import Path
from typing import Any

import click

from data_hub_watcher.cli import cli
from data_hub_watcher.constants import WATCHER_VERSION

PROG = "data-hub-watcher"
CATALOG_VERSION = "1"

# Default on-disk location next to the watcher package root (repo checkout).
DEFAULT_SNAPSHOT_PATH = Path(__file__).resolve().parents[2] / "cli-catalog.snapshot.json"


def _is_unset(value: Any) -> bool:
    # Click 8.3 uses ``click._utils.Sentinel.UNSET``; avoid importing private APIs.
    return type(value).__name__ == "Sentinel" and getattr(value, "name", None) == "UNSET"


def _format_default(value: Any) -> Any | None:
    """Serialize a Click default for JSON, dropping sentinels and callables."""
    if value is None or _is_unset(value):
        return None
    if callable(value):
        return None
    if isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, (list, tuple)):
        return list(value)
    return str(value)


def _format_type(param_type: click.ParamType) -> str:
    name = getattr(param_type, "name", None)
    if name:
        return str(name)
    return str(param_type)


def _choice_values(param_type: click.ParamType) -> list[str] | None:
    if isinstance(param_type, click.Choice):
        return list(param_type.choices)
    return None


def _option_cli_names(param: click.Option) -> list[str]:
    # Prefer long opts; keep declaration order from Click.
    names = [opt for opt in param.opts if opt.startswith("--")]
    if not names:
        names = list(param.opts)
    return names


def _param_entry(param: click.Parameter) -> dict[str, Any] | None:
    if isinstance(param, click.Option):
        names = _option_cli_names(param)
        if not names:
            return None
        entry: dict[str, Any] = {
            "name": names[0],
            "names": names,
            "paramType": "option",
            "type": _format_type(param.type),
            "required": bool(param.required),
            "isFlag": bool(param.is_flag),
            "help": (param.help or "").strip() or None,
        }
        default = _format_default(param.default)
        if default is not None and not param.is_flag:
            entry["default"] = default
        elif param.is_flag and param.default is True:
            entry["default"] = True
        if param.envvar:
            entry["envvar"] = param.envvar if isinstance(param.envvar, str) else list(param.envvar)
        if param.metavar and not param.is_flag:
            entry["metavar"] = str(param.metavar)
        elif not param.is_flag:
            type_name = _format_type(param.type)
            if type_name and type_name not in ("text", "string"):
                entry["metavar"] = type_name.upper()
        choices = _choice_values(param.type)
        if choices is not None:
            entry["choices"] = choices
        return entry

    if isinstance(param, click.Argument):
        name = param.name or (param.opts[0] if param.opts else "ARG")
        help_text = getattr(param, "help", None)
        entry = {
            "name": name.upper().replace("_", "-"),
            "names": [name],
            "paramType": "argument",
            "type": _format_type(param.type),
            "required": bool(param.required),
            "isFlag": False,
            "help": (help_text or "").strip() or None,
        }
        default = _format_default(param.default)
        if default is not None:
            entry["default"] = default
        choices = _choice_values(param.type)
        if choices is not None:
            entry["choices"] = choices
        return entry

    return None


def _command_help(cmd: click.Command) -> str:
    text = (cmd.help or cmd.short_help or "").strip()
    # Click stores the first paragraph; keep multi-line docstrings joined.
    return " ".join(line.strip() for line in text.splitlines() if line.strip())


def _walk_command(
    cmd: click.Command,
    *,
    name: str,
    path: list[str],
) -> dict[str, Any]:
    params: list[dict[str, Any]] = []
    for param in cmd.params:
        entry = _param_entry(param)
        if entry is not None:
            params.append(entry)

    node: dict[str, Any] = {
        "name": name,
        "path": path,
        "help": _command_help(cmd) or None,
        "params": params,
    }

    if isinstance(cmd, click.Group):
        children: list[dict[str, Any]] = []
        # Stable alphabetical order so snapshot diffs stay readable.
        for child_name in sorted(cmd.commands):
            child = cmd.commands[child_name]
            children.append(
                _walk_command(
                    child,
                    name=child_name,
                    path=[*path, child_name],
                )
            )
        node["commands"] = children

    return node


def build_cli_catalog(
    root: click.Group | None = None,
    *,
    prog: str = PROG,
    version: str = WATCHER_VERSION,
) -> dict[str, Any]:
    """Return a nested catalog document for the watcher Click CLI."""
    command = root or cli
    root_node = _walk_command(command, name=prog, path=[prog])
    return {
        "cliCatalog": CATALOG_VERSION,
        "prog": prog,
        "version": version,
        "command": root_node,
    }


def _serialize(catalog: dict[str, Any]) -> str:
    # sort_keys keeps snapshot diffs stable regardless of walker insertion order.
    return f"{json.dumps(catalog, indent=2, sort_keys=True)}\n"


def write_cli_catalog_snapshot(
    path: Path | None = None,
    *,
    catalog: dict[str, Any] | None = None,
) -> Path:
    """Write the catalog JSON (pretty-printed, trailing newline)."""
    target = path or DEFAULT_SNAPSHOT_PATH
    doc = catalog if catalog is not None else build_cli_catalog()
    target.write_text(_serialize(doc), encoding="utf-8")
    return target


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if args in (["-h"], ["--help"]):
        print(
            "Usage: python -m data_hub_watcher.cli_catalog [output.json]\n"
            "Write the watcher Click CLI catalog snapshot (stdout if omitted).",
            file=sys.stderr,
        )
        return 0

    if args:
        write_cli_catalog_snapshot(Path(args[0]))
    else:
        sys.stdout.write(_serialize(build_cli_catalog()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
