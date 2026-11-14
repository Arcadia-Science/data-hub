"""What the uploader does when the watch folder itself is gone (watcher 1.4.3).

Between the folder disappearing and the supervisor moving to the waiting state, every file
in it looks missing. The upload worker would drop the `pending_uploads` row of each one, for
good, and count a missing attempt toward the cap for each file someone requested. The uploader
asks `watch_folder_unavailable` first: when the folder is gone the file isn't missing, so the
row or the queue entry stays and nothing is counted.
"""

from __future__ import annotations
import threading
from collections.abc import Generator
from pathlib import Path
from typing import cast
from unittest.mock import MagicMock, patch

import pytest

from data_hub_watcher import uploader as uploader_module
from data_hub_watcher.constants import MAX_PENDING_UPLOAD_ATTEMPTS, MAX_QUEUE_FILE_ATTEMPTS
from data_hub_watcher.events import EventReporter
from data_hub_watcher.heartbeat import WatcherCounters
from data_hub_watcher.models import UploadQueueFile, UploadQueueResponse
from data_hub_watcher.state import StateDB
from data_hub_watcher.uploader import Uploader


class _Folder:
    """The answer to "is the watch folder gone?", and a count of how often it was asked."""

    def __init__(self) -> None:
        self.gone = False
        self.asked = 0

    def __call__(self) -> bool:
        self.asked += 1
        return self.gone


@pytest.fixture()
def state_db(tmp_path: Path) -> Generator[StateDB, None, None]:
    db = StateDB(tmp_path / "test.db")
    yield db
    db.close()


@pytest.fixture()
def folder() -> _Folder:
    return _Folder()


@pytest.fixture()
def uploader(state_db: StateDB, tmp_path: Path, folder: _Folder) -> Uploader:
    watch_dir = tmp_path / "data"
    watch_dir.mkdir()
    return Uploader(
        client=MagicMock(),
        state_db=state_db,
        event_reporter=MagicMock(spec=EventReporter),
        counters=WatcherCounters(),
        instrument_id="test-instrument",
        watcher_id="watcher-123",
        watch_directory=watch_dir,
        watch_folder_unavailable=folder,
    )


def _reporter(uploader: Uploader) -> MagicMock:
    return cast(MagicMock, uploader._reporter)


def _queue(uploader: Uploader, *names: str) -> None:
    client = cast(MagicMock, uploader._client)
    client.get_upload_queue.return_value = UploadQueueResponse(
        files=[
            UploadQueueFile(
                id=i + 1,
                instrument_id="test-instrument",
                run_id="RUN-X",
                filename=name,
                relative_path=name,
            )
            for i, name in enumerate(names)
        ]
    )


class TestPendingUploads:
    def test_a_file_that_is_missing_with_its_folder_still_there_is_dropped(
        self, uploader: Uploader, state_db: StateDB, folder: _Folder
    ) -> None:
        state_db.record_report(
            "RUN-1", [], new_run=False, pending_relative_paths=["RUN-1/deleted.csv"]
        )

        uploader.retry_pending_uploads()

        # Today's behavior for a file that really was deleted.
        assert state_db.pending_uploads() == []
        assert _reporter(uploader).report_error.call_args.args[0] == "pending_upload_missing"
        assert folder.asked == 1

    def test_a_file_in_a_folder_that_is_gone_keeps_its_row(
        self, uploader: Uploader, state_db: StateDB, folder: _Folder
    ) -> None:
        state_db.record_report(
            "RUN-1", [], new_run=False, pending_relative_paths=["RUN-1/a.csv", "RUN-1/b.csv"]
        )
        folder.gone = True

        with patch.object(uploader, "_upload_single") as upload:
            uploader.retry_pending_uploads()

        upload.assert_not_called()
        # Neither dropped nor counted: the next start retries them, with the folder back.
        assert [(p.relative_path, p.attempts) for p in state_db.pending_uploads()] == [
            ("RUN-1/a.csv", 0),
            ("RUN-1/b.csv", 0),
        ]
        _reporter(uploader).report_error.assert_not_called()

    def test_a_failed_attempt_is_not_counted_when_the_folder_went_away_meanwhile(
        self, uploader: Uploader, state_db: StateDB, folder: _Folder
    ) -> None:
        (uploader._watch_dir / "RUN-1").mkdir()
        (uploader._watch_dir / "RUN-1" / "a.csv").write_text("x")
        state_db.record_report("RUN-1", [], new_run=False, pending_relative_paths=["RUN-1/a.csv"])

        def fails_as_the_folder_goes(path: Path, run_id: str) -> bool:
            folder.gone = True
            return False

        with patch.object(uploader, "_upload_single", side_effect=fails_as_the_folder_goes):
            uploader.retry_pending_uploads()

        [pending] = state_db.pending_uploads()
        assert (pending.relative_path, pending.attempts) == ("RUN-1/a.csv", 0)

    def test_a_failed_attempt_with_the_folder_there_still_counts(
        self, uploader: Uploader, state_db: StateDB
    ) -> None:
        (uploader._watch_dir / "RUN-1").mkdir()
        (uploader._watch_dir / "RUN-1" / "a.csv").write_text("x")
        state_db.record_report("RUN-1", [], new_run=False, pending_relative_paths=["RUN-1/a.csv"])

        with patch.object(uploader, "_upload_single", return_value=False):
            uploader.retry_pending_uploads()

        [pending] = state_db.pending_uploads()
        assert pending.attempts == 1
        assert pending.attempts < MAX_PENDING_UPLOAD_ATTEMPTS

    def test_a_waiting_file_in_a_folder_that_is_gone_keeps_waiting_and_keeps_its_row(
        self, uploader: Uploader, state_db: StateDB, folder: _Folder
    ) -> None:
        locked = uploader._watch_dir / "locked.csv"
        locked.write_text("x")
        state_db.record_report("RUN-1", [], new_run=False, pending_relative_paths=["locked.csv"])
        key = "locked.csv"
        waiting = _wait_for(uploader, locked)
        locked.unlink()
        folder.gone = True

        with patch.object(uploader, "_upload_single") as upload:
            uploader.retry_waiting_files()

        upload.assert_not_called()
        # Still waiting, and the row is still there: it is retried once the folder is back.
        assert uploader._waiting == {key: waiting}
        assert [p.relative_path for p in state_db.pending_uploads()] == [key]
        _reporter(uploader).report_error.assert_not_called()

    def test_without_a_callback_the_folder_is_never_gone(
        self, state_db: StateDB, tmp_path: Path
    ) -> None:
        up = Uploader(
            client=MagicMock(),
            state_db=state_db,
            event_reporter=MagicMock(spec=EventReporter),
            counters=WatcherCounters(),
            instrument_id="test-instrument",
            watcher_id="watcher-123",
            watch_directory=tmp_path,
        )
        state_db.record_report("RUN-1", [], new_run=False, pending_relative_paths=["gone.csv"])

        up.retry_pending_uploads()

        assert state_db.pending_uploads() == []


class TestRequestedFiles:
    def test_a_requested_file_in_a_folder_that_is_gone_counts_no_attempt(
        self, uploader: Uploader, folder: _Folder
    ) -> None:
        _queue(uploader, "ghost.csv")
        folder.gone = True

        for _ in range(MAX_QUEUE_FILE_ATTEMPTS + 2):
            uploader.poll_upload_queue()

        client = cast(MagicMock, uploader._client)
        # Not cancelled, however many polls it takes the supervisor to move.
        client.cancel_upload_request.assert_not_called()
        assert uploader._queue_attempts == {}
        # And no "Queued file missing" error, which the folder explains.
        _reporter(uploader).queue_event.assert_not_called()
        assert uploader._counters.errors == 0

    def test_the_same_file_counts_once_the_folder_is_there_again_and_it_is_missing(
        self, uploader: Uploader, folder: _Folder
    ) -> None:
        _queue(uploader, "ghost.csv")
        folder.gone = True
        uploader.poll_upload_queue()
        assert uploader._queue_attempts == {}

        folder.gone = False
        for _ in range(MAX_QUEUE_FILE_ATTEMPTS):
            uploader.poll_upload_queue()

        client = cast(MagicMock, uploader._client)
        client.cancel_upload_request.assert_called_once_with(1)

    def test_an_upload_that_failed_because_the_folder_went_away_counts_no_attempt(
        self, uploader: Uploader, folder: _Folder
    ) -> None:
        (uploader._watch_dir / "data.csv").write_text("x")
        _queue(uploader, "data.csv")

        def fails_as_the_folder_goes(path: Path, run_id: str) -> bool:
            folder.gone = True
            return False

        with patch.object(uploader, "_upload_single", side_effect=fails_as_the_folder_goes):
            for _ in range(MAX_QUEUE_FILE_ATTEMPTS):
                uploader.poll_upload_queue()

        client = cast(MagicMock, uploader._client)
        client.cancel_upload_request.assert_not_called()
        assert uploader._queue_attempts == {}

    def test_the_folder_is_not_asked_about_for_a_file_that_is_there(
        self, uploader: Uploader, folder: _Folder
    ) -> None:
        (uploader._watch_dir / "data.csv").write_text("x")
        _queue(uploader, "data.csv")

        with patch.object(uploader, "_upload_single", return_value=True):
            uploader.poll_upload_queue()

        assert folder.asked == 0


class TestAStopIsNotAMissingFile:
    """A stop answers "not missing" without a look at the folder.

    The look has a limit of its own (10 s), and `Uploader.abort` can't cut it short. An upload
    thread that is in it during a stop holds the stop up, so the uploader doesn't look.

    Every caller checks for a stop before it gets to a file that can't be found, so the stop
    that matters arrives in between: these tests have it arrive as the file is looked for.
    """

    @staticmethod
    def _stop_as_the_file_is_looked_for(
        uploader: Uploader, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def missing_and_stopping(_path: Path) -> bool:
            uploader.abort()
            return False

        # A pending upload and a waiting file ask `_is_file`, a requested one `_exists`.
        monkeypatch.setattr(uploader_module, "_is_file", missing_and_stopping)
        monkeypatch.setattr(uploader_module, "_exists", missing_and_stopping)

    def test_a_pending_upload_is_neither_dropped_nor_looked_at_during_a_stop(
        self,
        uploader: Uploader,
        state_db: StateDB,
        folder: _Folder,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        state_db.record_report("RUN-1", [], new_run=False, pending_relative_paths=["RUN-1/a.csv"])
        self._stop_as_the_file_is_looked_for(uploader, monkeypatch)

        uploader.retry_pending_uploads()

        # The file is missing and the folder is there, so without the stop the row would be
        # dropped. It is left for the next start, which retries it, or drops it then.
        assert [p.relative_path for p in state_db.pending_uploads()] == ["RUN-1/a.csv"]
        _reporter(uploader).report_error.assert_not_called()
        assert folder.asked == 0

    def test_a_requested_file_stays_queued_and_counts_nothing_during_a_stop(
        self, uploader: Uploader, folder: _Folder, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _queue(uploader, "ghost.csv")
        self._stop_as_the_file_is_looked_for(uploader, monkeypatch)

        uploader.poll_upload_queue()

        client = cast(MagicMock, uploader._client)
        client.cancel_upload_request.assert_not_called()
        assert uploader._queue_attempts == {}
        _reporter(uploader).queue_event.assert_not_called()
        assert folder.asked == 0

    def test_a_waiting_file_keeps_waiting_during_a_stop(
        self,
        uploader: Uploader,
        state_db: StateDB,
        folder: _Folder,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        locked = uploader._watch_dir / "locked.csv"
        locked.write_text("x")
        state_db.record_report("RUN-1", [], new_run=False, pending_relative_paths=["locked.csv"])
        waiting = _wait_for(uploader, locked)
        self._stop_as_the_file_is_looked_for(uploader, monkeypatch)

        uploader.retry_waiting_files()

        assert uploader._waiting == {"locked.csv": waiting}
        assert [p.relative_path for p in state_db.pending_uploads()] == ["locked.csv"]
        assert folder.asked == 0

    def test_the_answer_during_a_stop_is_yes_without_asking(
        self, uploader: Uploader, folder: _Folder
    ) -> None:
        uploader.abort()

        assert uploader._folder_is_gone() is True
        assert folder.asked == 0

    def test_without_a_stop_the_folder_is_asked_about(
        self, uploader: Uploader, state_db: StateDB, folder: _Folder
    ) -> None:
        state_db.record_report("RUN-1", [], new_run=False, pending_relative_paths=["RUN-1/a.csv"])

        uploader.retry_pending_uploads()

        assert folder.asked == 1

    def test_even_without_a_callback_a_stop_keeps_a_file_that_cannot_be_found(
        self, state_db: StateDB, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        up = Uploader(
            client=MagicMock(),
            state_db=state_db,
            event_reporter=MagicMock(spec=EventReporter),
            counters=WatcherCounters(),
            instrument_id="test-instrument",
            watcher_id="watcher-123",
            watch_directory=tmp_path,
            stop_event=threading.Event(),
        )
        state_db.record_report("RUN-1", [], new_run=False, pending_relative_paths=["gone.csv"])
        self._stop_as_the_file_is_looked_for(up, monkeypatch)

        up.retry_pending_uploads()

        assert [p.relative_path for p in state_db.pending_uploads()] == ["gone.csv"]


def _wait_for(uploader: Uploader, path: Path) -> object:
    """Put *path* in the uploader's waiting collection, as a locked file is."""
    from data_hub_watcher.uploader import CantReadYet

    uploader._wait_for_file(path, "RUN-1", CantReadYet(path, "locked"))
    [waiting] = uploader._waiting.values()
    return waiting


def test_the_callback_may_be_called_from_several_threads(
    uploader: Uploader, folder: _Folder, state_db: StateDB
) -> None:
    # The upload worker's file threads all ask, so the answer has to be safe to ask for at once.
    state_db.record_report(
        "RUN-1",
        [],
        new_run=False,
        pending_relative_paths=[f"RUN-1/f{i}.csv" for i in range(8)],
    )
    folder.gone = True
    uploader._parallelism = 4

    threads = [threading.Thread(target=uploader.retry_pending_uploads) for _ in range(3)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(10)

    assert len(state_db.pending_uploads()) == 8
