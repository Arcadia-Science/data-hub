"""`StateDB.forget_prefix` and the `state forget` command."""

from __future__ import annotations
from pathlib import Path

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
        db.forget_prefix("../alice")
        raised = False
    except ValueError:
        raised = True
    assert raised
    db.close()


def test_state_forget_command_clears_the_configured_environment(tmp_path: Path) -> None:
    watch_dir = tmp_path / "data"
    watch_dir.mkdir()
    config_path = tmp_path / "config.yaml"
    save_config(
        WatcherConfig(
            version=1,
            environment="production",
            api_base_urls={"production": "https://example.test/api/v1"},
            watcher_ids={"production": "00000000-0000-4000-8000-000000000001"},
            instrument=InstrumentConfig(
                id="dishcam",
                watch_directory=watch_dir,
                file_patterns=["*.tif"],
                run_detection=RunDetectionConfig(pattern=r"^([^/]+)/", recursive=True),
            ),
        ),
        config_path,
    )
    db_path = tmp_path / "watcher-production.db"
    db = StateDB(db_path)
    _seed(db)
    db.close()

    result = CliRunner().invoke(
        cli,
        ["--config", str(config_path), "state", "forget", "--prefix", "alice/", "--yes"],
    )

    assert result.exit_code == 0, result.output
    assert "uploaded_files: 1" in result.output
    reopened = StateDB(db_path)
    remaining = _paths(reopened)
    reopened.close()
    assert "alice/day-1/capture/sample.tif" not in remaining
    assert "alice_notes/sample.tif" in remaining
