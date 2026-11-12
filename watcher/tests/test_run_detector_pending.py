"""Auto mode: a file the server has been told about is never left without a way to upload it.

A kill, or a write that fails, after the server accepted a run report used to leave the run
remembered as reported with no `pending_uploads` row: the next start had nothing to retry and
the initial scan skipped the files, so they stayed `detected` for good. The state DB now gets the
run, its manifest and the pending rows in one transaction after the server accepted the report.
A write that doesn't go through leaves none of it. A process that goes on retries the write, and
sends the server only the files it has not seen. A process that is killed leaves nothing, and the
next start reports the files again.

These tests use a real `StateDB`, `RunDetector` and `FileMonitor`, and a stand-in for the server
and the uploader.
"""

from __future__ import annotations
from collections.abc import Callable, Generator
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Literal
from unittest.mock import MagicMock

import pytest

from data_hub_watcher.monitor import FileMonitor
from data_hub_watcher.run_detector import FileInfo, RunDetector
from data_hub_watcher.state import StateDB

InitialScan = Literal["full", "new-only"]


@pytest.fixture()
def watch_dir(tmp_path: Path) -> Path:
    d = tmp_path / "watch"
    d.mkdir()
    return d


@pytest.fixture()
def db_path(tmp_path: Path) -> Path:
    return tmp_path / "state.db"


@dataclass
class Watcher:
    """The parts of one watcher process, built the way `runtime.build_runtime` builds them."""

    state_db: StateDB
    detector: RunDetector
    monitor: FileMonitor
    client: MagicMock
    uploads: list[tuple[str, list[str]]]

    def settle(self) -> None:
        """Run the stability check once, which hands every file found so far to the detector."""
        self.monitor._check_pending()


@pytest.fixture()
def processes(db_path: Path, watch_dir: Path) -> Generator[Callable[..., Watcher], None, None]:
    """Start watcher "processes" on the same state database, and close them at the end."""
    started: list[StateDB] = []

    def start(*, initial_scan: InitialScan = "full", auto: bool = True) -> Watcher:
        state_db = StateDB(db_path)
        started.append(state_db)
        client = MagicMock()
        client.report_run.return_value = SimpleNamespace(id="api-run")
        uploads: list[tuple[str, list[str]]] = []

        def upload(run_id: str, files: list[FileInfo]) -> int:
            uploads.append((run_id, [f.path.name for f in files]))
            return len(files)

        detector = RunDetector(
            pattern=r"^([^/]+)/",
            instrument_id="inst-1",
            watcher_id="watcher-1",
            client=client,
            state_db=state_db,
            event_reporter=MagicMock(),
            counters=MagicMock(runs_reported=0, errors=0),
            upload_callback=upload if auto else None,
            watch_directory=watch_dir,
        )
        # As in `runtime.build_runtime`, read before anything is scanned.
        seed_baseline = initial_scan == "new-only" and not state_db.baseline_established()
        monitor = FileMonitor(
            watch_directory=watch_dir,
            file_patterns=["*.csv"],
            stability_period=0,
            on_stable_file=detector.on_stable_file,
            state_db=state_db,
            recursive=True,
            seed_baseline=seed_baseline,
        )
        # As in `start_runtime`: hydrate, then scan.
        detector.hydrate_from_state_db()
        monitor._initial_scan()
        return Watcher(state_db, detector, monitor, client, uploads)

    yield start
    for state_db in started:
        state_db.close()


def _write(watch_dir: Path, relative: str) -> Path:
    path = watch_dir / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(relative)
    return path


def _arrive(watcher: Watcher, path: Path) -> None:
    """A file shows up while the watcher runs, and becomes stable."""
    watcher.monitor._enqueue(path)
    watcher.settle()


def _refuse_pending_rows(state_db: StateDB) -> None:
    """Make writes to `pending_uploads` fail, as a write that can't be made does."""
    state_db._conn.execute(
        "CREATE TRIGGER refuse_pending BEFORE INSERT ON pending_uploads "
        "BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END"
    )
    state_db._conn.commit()


def _allow_pending_rows(state_db: StateDB) -> None:
    state_db._conn.execute("DROP TRIGGER refuse_pending")
    state_db._conn.commit()


def _retry_now(watcher: Watcher) -> None:
    """Make the scheduled retries due and run the monitor's tick, which retries one."""
    for run_id in watcher.detector._retry_at:
        watcher.detector._retry_at[run_id] = 0.0
    watcher.detector.retry_failed_reports()


def _state(state_db: StateDB, run_id: str) -> tuple[bool, list[str], list[str]]:
    """Whether the run is remembered, its manifest, and its pending uploads."""
    return (
        state_db.get_run(run_id) is not None,
        [r.relative_path for r in state_db.get_detected_files_for_run(run_id)],
        [p.relative_path for p in state_db.pending_uploads() if p.run_id == run_id],
    )


class TestWhatIsRecordedWithTheReport:
    def test_the_pending_rows_are_there_before_the_upload_starts(
        self, processes: Callable[..., Watcher], watch_dir: Path
    ) -> None:
        w = processes()
        seen: list[tuple[bool, list[str], list[str]]] = []

        def upload(run_id: str, files: list[FileInfo]) -> int:
            # What a kill at this moment would leave for the next start.
            seen.append(_state(w.state_db, run_id))
            return len(files)

        w.detector._upload_cb = upload

        _arrive(w, _write(watch_dir, "RUN1/a.csv"))

        assert seen == [(True, ["RUN1/a.csv"], ["RUN1/a.csv"])]

    def test_a_file_added_to_a_reported_run_is_recorded_pending_too(
        self, processes: Callable[..., Watcher], watch_dir: Path
    ) -> None:
        w = processes()
        _arrive(w, _write(watch_dir, "RUN1/a.csv"))
        w.state_db.clear_pending_upload("RUN1/a.csv")  # Its upload succeeded.
        seen: list[tuple[bool, list[str], list[str]]] = []

        def upload(run_id: str, files: list[FileInfo]) -> int:
            seen.append(_state(w.state_db, run_id))
            return len(files)

        w.detector._upload_cb = upload

        _arrive(w, _write(watch_dir, "RUN1/b.csv"))

        w.client.update_run.assert_called_once()
        assert seen == [(True, ["RUN1/a.csv", "RUN1/b.csv"], ["RUN1/b.csv"])]

    def test_adding_a_file_to_a_run_does_not_move_its_reported_time(
        self, processes: Callable[..., Watcher], watch_dir: Path
    ) -> None:
        w = processes()
        _arrive(w, _write(watch_dir, "RUN1/a.csv"))
        # The updater waits for a quiet instrument by the newest `reported_at`.
        w.state_db._conn.execute("UPDATE runs SET reported_at = '2020-01-01T00:00:00+00:00'")
        w.state_db._conn.commit()

        _arrive(w, _write(watch_dir, "RUN1/b.csv"))

        w.client.update_run.assert_called_once()
        run = w.state_db.get_run("RUN1")
        assert run is not None and run.reported_at == "2020-01-01T00:00:00+00:00"

    def test_a_report_only_file_gets_no_pending_row(
        self, processes: Callable[..., Watcher], watch_dir: Path
    ) -> None:
        w = processes()
        w.detector.on_stable_file(_write(watch_dir, "RUN1/old.csv"), upload=False)
        w.detector.on_stable_file(_write(watch_dir, "RUN1/new.csv"))

        assert _state(w.state_db, "RUN1") == (
            True,
            ["RUN1/new.csv", "RUN1/old.csv"],
            ["RUN1/new.csv"],
        )
        assert w.uploads == [("RUN1", ["new.csv"])]

    def test_manual_mode_records_no_pending_rows(
        self, processes: Callable[..., Watcher], watch_dir: Path
    ) -> None:
        w = processes(auto=False)

        _arrive(w, _write(watch_dir, "RUN1/a.csv"))
        _arrive(w, _write(watch_dir, "RUN1/b.csv"))

        assert _state(w.state_db, "RUN1") == (True, ["RUN1/a.csv", "RUN1/b.csv"], [])
        assert w.uploads == []


class TestAWriteThatFails:
    def test_nothing_is_remembered_the_files_are_not_uploaded_and_the_run_counts_as_reported(
        self, processes: Callable[..., Watcher], watch_dir: Path
    ) -> None:
        w = processes()
        _refuse_pending_rows(w.state_db)
        path = _write(watch_dir, "RUN1/a.csv")

        w.detector.on_stable_file(path)  # Does not raise: the detector retries and reports it.

        w.client.report_run.assert_called_once()
        assert _state(w.state_db, "RUN1") == (False, [], [])
        assert w.state_db.get_reported_run_ids_with_files() == []
        assert w.uploads == []
        run = w.detector._runs["RUN1"]
        # The server has the run, so the run is never POSTed again for this.
        assert run.reported and run.unrecorded == "create" and run.patched_file_count == 1
        assert "RUN1" in w.detector._retry_at

    @pytest.mark.parametrize("initial_scan", ["full", "new-only"])
    def test_the_next_start_reports_the_run_again_and_uploads_its_files(
        self, processes: Callable[..., Watcher], watch_dir: Path, initial_scan: InitialScan
    ) -> None:
        first = processes(initial_scan=initial_scan)
        _refuse_pending_rows(first.state_db)
        path = _write(watch_dir, "RUN1/a.csv")
        first.monitor._enqueue(path)
        first.settle()  # The detector reports the failure and goes on.
        assert _state(first.state_db, "RUN1") == (False, [], [])
        _allow_pending_rows(first.state_db)  # There is room again by the next start.
        first.state_db.close()  # The process dies before its retry.

        # The next start: the file is no baseline file and no known one, so the scan finds it.
        second = processes(initial_scan=initial_scan)
        if initial_scan == "new-only":
            # The first start baselined the folder, so this one doesn't baseline it again.
            assert second.state_db.baseline_established()
        assert second.monitor._pending.keys() == {path}
        second.settle()

        assert second.client.report_run.call_count == 1
        sent = second.client.report_run.call_args.args[1]["detected_files"]
        assert [f["relative_path"] for f in sent] == ["RUN1/a.csv"]
        assert second.uploads == [("RUN1", ["a.csv"])]
        assert _state(second.state_db, "RUN1") == (True, ["RUN1/a.csv"], ["RUN1/a.csv"])
        assert list(second.state_db.iter_baseline_stat_keys()) == []

    @pytest.mark.parametrize("initial_scan", ["full", "new-only"])
    def test_the_next_start_finds_every_file_the_process_could_not_record(
        self, processes: Callable[..., Watcher], watch_dir: Path, initial_scan: InitialScan
    ) -> None:
        first = processes(initial_scan=initial_scan)
        _refuse_pending_rows(first.state_db)
        paths = [_write(watch_dir, f"RUN1/{name}.csv") for name in ("a", "b", "c")]
        for path in paths:
            _arrive(first, path)  # One POST, then a PATCH for each later file.
        assert _state(first.state_db, "RUN1") == (False, [], [])
        _allow_pending_rows(first.state_db)
        first.state_db.close()

        second = processes(initial_scan=initial_scan)
        assert second.monitor._pending.keys() == set(paths)
        second.settle()

        # The first file found is a POST and the others PATCHes, and together they carry all three.
        second.client.report_run.assert_called_once()
        sent = [second.client.report_run.call_args.args[1]["detected_files"]]
        sent += [c.args[2]["detected_files"] for c in second.client.update_run.call_args_list]
        assert sorted(f["relative_path"] for files in sent for f in files) == [
            "RUN1/a.csv",
            "RUN1/b.csv",
            "RUN1/c.csv",
        ]
        assert sorted(name for _, names in second.uploads for name in names) == [
            "a.csv",
            "b.csv",
            "c.csv",
        ]
        recorded, manifest, pending = _state(second.state_db, "RUN1")
        assert recorded
        assert sorted(manifest) == sorted(pending) == ["RUN1/a.csv", "RUN1/b.csv", "RUN1/c.csv"]

    def test_the_next_file_of_the_run_is_a_patch_that_carries_the_run_to_the_state_db(
        self, processes: Callable[..., Watcher], watch_dir: Path
    ) -> None:
        w = processes()
        _refuse_pending_rows(w.state_db)
        w.detector.on_stable_file(_write(watch_dir, "RUN1/a.csv"))
        _allow_pending_rows(w.state_db)

        w.detector.on_stable_file(_write(watch_dir, "RUN1/b.csv"))

        # The server has the run, so a PATCH of the new file and no second POST. The write
        # after it records the run, both files and both pending rows, and both are uploaded.
        w.client.report_run.assert_called_once()
        sent = w.client.update_run.call_args.args[2]["detected_files"]
        assert [f["relative_path"] for f in sent] == ["RUN1/b.csv"]
        assert w.uploads == [("RUN1", ["a.csv", "b.csv"])]
        assert _state(w.state_db, "RUN1") == (
            True,
            ["RUN1/a.csv", "RUN1/b.csv"],
            ["RUN1/a.csv", "RUN1/b.csv"],
        )
        assert w.detector._retry_at == {}

    def test_a_retry_records_the_run_without_a_new_file_or_a_request(
        self, processes: Callable[..., Watcher], watch_dir: Path
    ) -> None:
        w = processes()
        _refuse_pending_rows(w.state_db)
        w.detector.on_stable_file(_write(watch_dir, "RUN1/a.csv"))
        _retry_now(w)  # Still no room.
        assert _state(w.state_db, "RUN1") == (False, [], [])
        _allow_pending_rows(w.state_db)

        _retry_now(w)

        w.client.report_run.assert_called_once()
        w.client.update_run.assert_not_called()
        assert w.uploads == [("RUN1", ["a.csv"])]
        assert _state(w.state_db, "RUN1") == (True, ["RUN1/a.csv"], ["RUN1/a.csv"])
        assert w.detector._retry_at == {}

    def test_a_run_that_cannot_be_written_for_many_files_sends_small_requests(
        self, processes: Callable[..., Watcher], watch_dir: Path
    ) -> None:
        w = processes()
        _refuse_pending_rows(w.state_db)
        names = [f"f{n}.csv" for n in range(8)]
        for name in names:
            _arrive(w, _write(watch_dir, f"RUN1/{name}"))

        # One POST and a PATCH of one file each, not a POST of every file seen so far.
        w.client.report_run.assert_called_once()
        sent = [c.args[2]["detected_files"] for c in w.client.update_run.call_args_list]
        assert [[f["filename"] for f in files] for files in sent] == [[n] for n in names[1:]]
        assert w.uploads == []
        _allow_pending_rows(w.state_db)

        _retry_now(w)

        assert _state(w.state_db, "RUN1") == (
            True,
            [f"RUN1/{n}" for n in names],
            [f"RUN1/{n}" for n in names],
        )
        assert w.uploads == [("RUN1", names)]

    def test_a_report_only_file_still_gets_no_pending_row_when_the_write_comes_later(
        self, processes: Callable[..., Watcher], watch_dir: Path
    ) -> None:
        w = processes()
        _refuse_pending_rows(w.state_db)
        w.detector.on_stable_file(_write(watch_dir, "RUN1/a.csv"))
        w.detector.on_stable_file(_write(watch_dir, "RUN1/old.csv"), upload=False)
        _allow_pending_rows(w.state_db)

        w.detector.on_stable_file(_write(watch_dir, "RUN1/new.csv"))

        # The backlog (a) and the new file are pending, and the report-only file is not.
        assert _state(w.state_db, "RUN1") == (
            True,
            ["RUN1/a.csv", "RUN1/new.csv", "RUN1/old.csv"],
            ["RUN1/a.csv", "RUN1/new.csv"],
        )
        assert w.uploads == [("RUN1", ["a.csv", "new.csv"])]

    def test_a_patch_that_is_not_recorded_is_not_sent_again_with_the_next_file(
        self, processes: Callable[..., Watcher], watch_dir: Path
    ) -> None:
        w = processes()
        w.detector.on_stable_file(_write(watch_dir, "RUN1/a.csv"))
        w.state_db.clear_pending_upload("RUN1/a.csv")
        _refuse_pending_rows(w.state_db)

        w.detector.on_stable_file(_write(watch_dir, "RUN1/b.csv"))

        # The first file's rows are still there, and nothing of the second. The server has it.
        assert _state(w.state_db, "RUN1") == (True, ["RUN1/a.csv"], [])
        run = w.detector._runs["RUN1"]
        assert run.patched_file_count == 2 and run.unrecorded == "update"
        _allow_pending_rows(w.state_db)

        w.detector.on_stable_file(_write(watch_dir, "RUN1/c.csv"))

        sent = [c.args[2]["detected_files"] for c in w.client.update_run.call_args_list]
        assert [[f["relative_path"] for f in files] for files in sent] == [
            ["RUN1/b.csv"],
            ["RUN1/c.csv"],
        ]
        assert w.uploads == [("RUN1", ["a.csv"]), ("RUN1", ["b.csv", "c.csv"])]
        assert _state(w.state_db, "RUN1") == (
            True,
            ["RUN1/a.csv", "RUN1/b.csv", "RUN1/c.csv"],
            ["RUN1/b.csv", "RUN1/c.csv"],
        )

    @pytest.mark.parametrize("initial_scan", ["full", "new-only"])
    def test_the_next_start_sends_the_unrecorded_patch_again(
        self, processes: Callable[..., Watcher], watch_dir: Path, initial_scan: InitialScan
    ) -> None:
        first = processes(initial_scan=initial_scan)
        _arrive(first, _write(watch_dir, "RUN1/a.csv"))
        first.state_db.clear_pending_upload("RUN1/a.csv")
        _refuse_pending_rows(first.state_db)
        late = _write(watch_dir, "RUN1/b.csv")
        first.monitor._enqueue(late)
        first.settle()
        assert _state(first.state_db, "RUN1") == (True, ["RUN1/a.csv"], [])
        _allow_pending_rows(first.state_db)  # There is room again by the next start.
        first.state_db.close()

        second = processes(initial_scan=initial_scan)
        assert second.monitor._pending.keys() == {late}
        second.settle()

        # The run is hydrated, so the late file is a PATCH.
        second.client.report_run.assert_not_called()
        sent = second.client.update_run.call_args.args[2]["detected_files"]
        assert [f["relative_path"] for f in sent] == ["RUN1/b.csv"]
        assert second.uploads == [("RUN1", ["b.csv"])]
        assert _state(second.state_db, "RUN1") == (
            True,
            ["RUN1/a.csv", "RUN1/b.csv"],
            ["RUN1/b.csv"],
        )


class TestACommittedReport:
    @pytest.mark.parametrize("initial_scan", ["full", "new-only"])
    def test_the_next_start_retries_the_upload_without_reporting_again(
        self, processes: Callable[..., Watcher], watch_dir: Path, initial_scan: InitialScan
    ) -> None:
        first = processes(initial_scan=initial_scan)
        path = _write(watch_dir, "RUN1/a.csv")
        # The kill comes right after the commit: the upload never started.
        first.detector._upload_cb = MagicMock(side_effect=SystemExit)
        with pytest.raises(SystemExit):
            first.detector.on_stable_file(path)
        first.state_db.close()

        second = processes(initial_scan=initial_scan)

        # The scan skips the file, and what retries it is the pending row.
        assert second.monitor._pending == {}
        assert [(p.relative_path, p.run_id) for p in second.state_db.pending_uploads()] == [
            ("RUN1/a.csv", "RUN1")
        ]
        second.client.report_run.assert_not_called()
