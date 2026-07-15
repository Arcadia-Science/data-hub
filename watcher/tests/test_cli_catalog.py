"""Smoke checks for the watcher Click CLI catalog builder."""

from __future__ import annotations
from pathlib import Path

from data_hub_watcher.cli_catalog import (
    DEFAULT_SNAPSHOT_PATH,
    build_cli_catalog,
)


def test_cli_catalog_default_snapshot_path() -> None:
    assert DEFAULT_SNAPSHOT_PATH == (
        Path(__file__).resolve().parents[1] / "cli-catalog.snapshot.json"
    )


def test_cli_catalog_includes_core_commands() -> None:
    catalog = build_cli_catalog()
    names = {child["name"] for child in catalog["command"]["commands"]}
    assert names == {
        "config",
        "init",
        "self-update",
        "service",
        "upload",
        "watch",
    }
    root_flags = {p["name"] for p in catalog["command"]["params"]}
    assert {"--config", "--verbose", "--version"} <= root_flags
