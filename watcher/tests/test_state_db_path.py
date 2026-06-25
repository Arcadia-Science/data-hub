"""Per-environment state DB path resolution, legacy migration, and reset."""

from __future__ import annotations
from pathlib import Path

from data_hub_watcher.constants import (
    STATE_DB_FILENAME,
    reset_state_db,
    resolve_state_db_path,
    state_db_path,
)


def test_path_is_environment_scoped(tmp_path: Path) -> None:
    assert state_db_path(tmp_path, "production") == tmp_path / "watcher-production.db"
    assert state_db_path(tmp_path, "staging") == tmp_path / "watcher-staging.db"


def test_resolve_creates_no_file_when_nothing_exists(tmp_path: Path) -> None:
    target = resolve_state_db_path(tmp_path, "staging")
    assert target == tmp_path / "watcher-staging.db"
    assert not target.exists()


def test_resolve_migrates_legacy_db_with_sidecars_once(tmp_path: Path) -> None:
    (tmp_path / STATE_DB_FILENAME).write_text("main")
    (tmp_path / f"{STATE_DB_FILENAME}-wal").write_text("wal")
    (tmp_path / f"{STATE_DB_FILENAME}-shm").write_text("shm")

    target = resolve_state_db_path(tmp_path, "production")

    assert target == tmp_path / "watcher-production.db"
    assert target.read_text() == "main"
    assert (tmp_path / "watcher-production.db-wal").read_text() == "wal"
    assert (tmp_path / "watcher-production.db-shm").read_text() == "shm"
    assert not (tmp_path / STATE_DB_FILENAME).exists()

    # Idempotent: a second resolve is a no-op now that the target exists.
    assert resolve_state_db_path(tmp_path, "production").read_text() == "main"


def test_resolve_does_not_clobber_existing_target(tmp_path: Path) -> None:
    (tmp_path / STATE_DB_FILENAME).write_text("legacy")
    (tmp_path / "watcher-production.db").write_text("existing")

    resolved = resolve_state_db_path(tmp_path, "production")

    assert resolved.read_text() == "existing"
    # Legacy is left untouched so a different environment can still claim it.
    assert (tmp_path / STATE_DB_FILENAME).exists()


def test_reset_removes_db_and_sidecars(tmp_path: Path) -> None:
    (tmp_path / "watcher-preview.db").write_text("db")
    (tmp_path / "watcher-preview.db-wal").write_text("wal")
    (tmp_path / "watcher-preview.db-shm").write_text("shm")

    reset_state_db(tmp_path, "preview")

    assert not (tmp_path / "watcher-preview.db").exists()
    assert not (tmp_path / "watcher-preview.db-wal").exists()
    assert not (tmp_path / "watcher-preview.db-shm").exists()


def test_reset_missing_is_noop(tmp_path: Path) -> None:
    reset_state_db(tmp_path, "preview")
