"""`StateDB.forget_prefix` and the `state forget` command."""

from __future__ import annotations
from pathlib import Path
from typing import Any, Literal

import pytest
from click.testing import CliRunner

from data_hub_watcher.cli import cli
from data_hub_watcher.config_io import save_config
from data_hub_watcher.models import InstrumentConfig, RunDetectionConfig, WatcherConfig
from data_hub_watcher.state import StateDB


def _seed(db: StateDB) -> None:
    db.record_upload(
        "sample.tif",
        "abc",
        "dishcam/alice/sample.tif",
        relative_path="alice/day-1/capture/sample.tif",
        size_bytes=10,
        mtime=1.0,
    )
    db.record_upload(
        "sample.tif",
        "def",
        "dishcam/alice_notes/sample.tif",
        relative_path="alice_notes/sample.tif",
        size_bytes=10,
        mtime=1.0,
    )
    db.record_upload(
        "other.tif",
        "ghi",
        "dishcam/other.tif",
        relative_path="other/other.tif",
        size_bytes=10,
        mtime=1.0,
    )
    db.record_detected_files(
        "alice",
        [
            ("alice/day-1/capture/sample.tif", "sample.tif", 10, 1.0, 1.0),
            ("alice_notes/sample.tif", "sample.tif", 10, 1.0, 1.0),
        ],
    )
    db.record_baseline_files(
        [
            ("alice/old.tif", 1, 1.0),
            ("alice_extra/old.tif", 1, 1.0),
        ]
    )


def _paths(db: StateDB) -> set[str]:
    uploaded = {row[0] for row in db.iter_uploaded_stat_keys()}
    detected = {
        record.relative_path
        for run_id in db.get_reported_run_ids_with_files()
        for record in db.get_detected_files_for_run(run_id)
    }
    baseline = {row[0] for row in db.iter_baseline_stat_keys()}
    return uploaded | detected | baseline


def test_forget_prefix_removes_only_that_folder(tmp_path: Path) -> None:
    db = StateDB(tmp_path / "state.db")
    _seed(db)

    counts = db.forget_prefix("alice/")

    assert counts == {"uploaded_files": 1, "detected_files": 1, "baseline_files": 1}
    remaining = _paths(db)
    assert "alice/day-1/capture/sample.tif" not in remaining
    assert "alice/old.tif" not in remaining
    # `_` is not a wildcard here: a sibling folder that merely starts
    # with the same letters stays put.
    assert "alice_notes/sample.tif" in remaining
    assert "alice_extra/old.tif" in remaining
    assert "other/other.tif" in remaining
    db.close()


def test_forget_prefix_rejects_a_path_that_escapes(tmp_path: Path) -> None:
    db = StateDB(tmp_path / "state.db")
    try:
        with pytest.raises(ValueError):
            db.forget_prefix("../alice")
    finally:
        db.close()


@pytest.fixture(autouse=True)
def fake_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Stand in for `~/.data-hub`, where `watch` keeps state, and hide any service."""
    import data_hub_watcher.cli as cli_module
    import data_hub_watcher.constants as constants_module

    home = tmp_path / "home" / ".data-hub"
    home.mkdir(parents=True)
    monkeypatch.setattr(constants_module, "DEFAULT_CONFIG_DIR", home)
    monkeypatch.setattr(cli_module, "_installed_service_config", lambda: None)
    return home


def _write_config(
    config_dir: Path,
    environment: Literal["staging", "production", "preview"] = "production",
) -> Path:
    watch_dir = config_dir / "data"
    watch_dir.mkdir(parents=True)
    config_path = config_dir / "config.yaml"
    save_config(
        WatcherConfig(
            version=1,
            environment=environment,
            api_base_urls={environment: "https://example.test/api/v1"},
            watcher_ids={environment: "00000000-0000-4000-8000-000000000001"},
            instrument=InstrumentConfig(
                id="dishcam",
                watch_directory=watch_dir,
                file_patterns=["*.tif"],
                run_detection=RunDetectionConfig(pattern=r"^([^/]+)/", recursive=True),
            ),
        ),
        config_path,
    )
    return config_path


def _seeded_db(db_path: Path) -> Path:
    db = StateDB(db_path)
    _seed(db)
    db.close()
    return db_path


def _remaining(db_path: Path) -> set[str]:
    db = StateDB(db_path)
    try:
        return _paths(db)
    finally:
        db.close()


def _forget(config_path: Path, *extra: str) -> Any:
    return CliRunner().invoke(
        cli,
        ["--config", str(config_path), "state", "forget", "--prefix", "alice/", *extra],
    )


def test_state_forget_clears_the_service_db_beside_the_config(tmp_path: Path) -> None:
    config_path = _write_config(tmp_path / "service")
    db_path = _seeded_db(tmp_path / "service" / "watcher-production.db")

    result = _forget(config_path, "--yes")

    assert result.exit_code == 0, result.output
    assert str(db_path) in result.output
    assert "uploaded_files: 1" in result.output
    remaining = _remaining(db_path)
    assert "alice/day-1/capture/sample.tif" not in remaining
    assert "alice_notes/sample.tif" in remaining


def test_state_forget_clears_the_db_watch_uses_with_a_custom_config(
    tmp_path: Path, fake_home: Path
) -> None:
    # `watch --config elsewhere/config.yaml` still keeps state in ~/.data-hub.
    config_path = _write_config(tmp_path / "elsewhere")
    db_path = _seeded_db(fake_home / "watcher-production.db")

    result = _forget(config_path, "--yes")

    assert result.exit_code == 0, result.output
    assert str(db_path) in result.output
    assert "alice/day-1/capture/sample.tif" not in _remaining(db_path)


def test_state_forget_clears_the_installed_service_db_too(
    tmp_path: Path, fake_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import data_hub_watcher.cli as cli_module

    # An operator's old interactive run left a DB in ~/.data-hub. The
    # service runs from its own config, possibly in another environment.
    operator_config = _write_config(fake_home, environment="staging")
    operator_db = _seeded_db(fake_home / "watcher-staging.db")
    service_config = _write_config(tmp_path / "service")
    service_db = _seeded_db(tmp_path / "service" / "watcher-production.db")
    monkeypatch.setattr(cli_module, "_installed_service_config", lambda: service_config)

    result = _forget(operator_config, "--yes")

    assert result.exit_code == 0, result.output
    assert str(operator_db) in result.output
    assert str(service_db) in result.output
    assert "alice/day-1/capture/sample.tif" not in _remaining(operator_db)
    assert "alice/day-1/capture/sample.tif" not in _remaining(service_db)


def test_state_forget_lists_every_db_before_asking(tmp_path: Path) -> None:
    config_path = _write_config(tmp_path / "service")
    db_path = _seeded_db(tmp_path / "service" / "watcher-production.db")

    result = CliRunner().invoke(
        cli,
        ["--config", str(config_path), "state", "forget", "--prefix", "alice/"],
        input="n\n",
    )

    assert result.exit_code != 0
    assert result.output.index(str(db_path)) < result.output.index("Continue?")
    assert "alice/day-1/capture/sample.tif" in _remaining(db_path)


def test_state_forget_rejects_an_unsafe_prefix_before_asking(tmp_path: Path) -> None:
    config_path = _write_config(tmp_path / "service")
    _seeded_db(tmp_path / "service" / "watcher-production.db")

    result = CliRunner().invoke(
        cli,
        ["--config", str(config_path), "state", "forget", "--prefix", "../alice"],
    )

    assert result.exit_code != 0
    assert "unsafe prefix" in result.output
    assert "Continue?" not in result.output


def test_state_forget_refuses_a_missing_database(tmp_path: Path, fake_home: Path) -> None:
    config_path = _write_config(tmp_path / "service")
    service_db = tmp_path / "service" / "watcher-production.db"
    watch_db = fake_home / "watcher-production.db"

    result = _forget(config_path, "--yes")

    assert result.exit_code != 0, result.output
    assert str(service_db) in result.output
    assert str(watch_db) in result.output
    assert "--config" in result.output
    assert not service_db.exists()
    assert not watch_db.exists()


def test_state_forget_warns_when_nothing_matches(tmp_path: Path) -> None:
    config_path = _write_config(tmp_path / "service")
    db = StateDB(tmp_path / "service" / "watcher-production.db")
    db.record_upload(
        "other.tif",
        "ghi",
        "dishcam/other.tif",
        relative_path="other/other.tif",
        size_bytes=10,
        mtime=1.0,
    )
    db.close()

    result = _forget(config_path, "--yes")

    assert result.exit_code == 0, result.output
    assert "nothing matched" in result.output
    assert "case-sensitive" in result.output
