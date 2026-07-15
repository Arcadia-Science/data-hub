"""Smoke checks for the watcher Click CLI catalog builder."""

from __future__ import annotations
import json
from pathlib import Path

from data_hub_watcher.cli_catalog import (
    build_cli_catalog,
    write_cli_catalog_snapshot,
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


def test_cli_catalog_build_is_deterministic() -> None:
    # A stable walk keeps regenerated snapshots from churning the docs diff.
    assert build_cli_catalog() == build_cli_catalog()


def test_write_cli_catalog_snapshot_round_trips(tmp_path: Path) -> None:
    target = write_cli_catalog_snapshot(tmp_path / "cli-catalog.snapshot.json")
    assert json.loads(target.read_text(encoding="utf-8")) == build_cli_catalog()
