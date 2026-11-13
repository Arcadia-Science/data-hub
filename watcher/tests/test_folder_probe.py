"""`FolderProbe`: a look at the watch folder that a hung share can't hold (watcher 1.4.3).

The supervisor's `poll` thread makes the look, and it is the thread that sees a stop. A stat
on a hung network share can block for a minute or more, or for good, so the look runs on a
daemon thread that `poll` waits for only for a limited time.
"""

from __future__ import annotations
import os
import threading
import time
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from data_hub_watcher import folder_probe, models
from data_hub_watcher.folder_probe import FolderLook, FolderProbe, look_at_folder


class _Hang:
    """A stand-in for `watch_directory_problem` that blocks like a stat on a dead share."""

    def __init__(self) -> None:
        self.release = threading.Event()
        self.calls: list[Path] = []
        self.threads: list[threading.Thread] = []

    def __call__(self, path: Path) -> str | None:
        self.calls.append(path)
        self.threads.append(threading.current_thread())
        # Longer than the tests wait for a look.
        self.release.wait(8)
        return None


@pytest.fixture
def hang(monkeypatch: pytest.MonkeyPatch) -> Iterator[_Hang]:
    stub = _Hang()
    monkeypatch.setattr(models, "watch_directory_problem", stub)
    try:
        yield stub
    finally:
        stub.release.set()


class TestLookAtFolder:
    def test_a_folder_that_can_be_listed_has_no_problem_and_an_identity(
        self, tmp_path: Path
    ) -> None:
        look = look_at_folder(tmp_path)

        status = os.stat(tmp_path)
        assert look == FolderLook(problem=None, identity=(status.st_dev, status.st_ino))

    def test_a_missing_folder_is_a_problem_with_no_identity(self, tmp_path: Path) -> None:
        look = look_at_folder(tmp_path / "gone")

        assert look.problem == f"watch_directory not found: {tmp_path / 'gone'}"
        assert look.identity is None

    def test_an_inode_number_of_zero_says_nothing_about_the_folder(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Some SMB servers report 0 for every file, so two folders would look the same.
        real = os.stat(tmp_path)
        fake = SimpleNamespace(st_dev=real.st_dev, st_ino=0)
        monkeypatch.setattr(folder_probe, "os", SimpleNamespace(stat=lambda _p: fake))

        assert look_at_folder(tmp_path) == FolderLook(problem=None, identity=None)

    def test_a_folder_that_goes_away_between_the_two_looks_is_a_problem(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def gone(_path: Path) -> Any:
            raise FileNotFoundError(2, "No such file or directory")

        monkeypatch.setattr(folder_probe, "os", SimpleNamespace(stat=gone))

        look = look_at_folder(tmp_path)

        assert look.problem is not None
        assert look.problem.startswith("watch_directory is not readable")
        assert look.identity is None


class TestFolderProbe:
    def test_a_look_that_answers_gives_its_result(self, tmp_path: Path) -> None:
        probe = FolderProbe(5)

        assert probe.problem(tmp_path) is None
        assert probe.problem(tmp_path / "gone") == f"watch_directory not found: {tmp_path / 'gone'}"

    def test_the_look_runs_on_its_own_thread(self, tmp_path: Path, hang: _Hang) -> None:
        hang.release.set()

        FolderProbe(5).problem(tmp_path)

        assert hang.threads and hang.threads[0] is not threading.current_thread()
        assert hang.threads[0].daemon

    def test_a_look_that_hangs_is_reported_as_not_responding_within_the_timeout(
        self, tmp_path: Path, hang: _Hang
    ) -> None:
        probe = FolderProbe(0.3)

        started = time.monotonic()
        look = probe.look(tmp_path)

        assert time.monotonic() - started < 5
        assert look == FolderLook(problem=f"watch_directory not responding: {tmp_path}")

    def test_a_look_that_is_still_running_is_waited_for_and_not_started_again(
        self, tmp_path: Path, hang: _Hang
    ) -> None:
        probe = FolderProbe(0.2)

        first = probe.problem(tmp_path)
        second = probe.problem(tmp_path)
        third = probe.problem(tmp_path)

        assert first == second == third == f"watch_directory not responding: {tmp_path}"
        # One blocked thread for three looks, not one each.
        assert len(hang.calls) == 1

    def test_a_look_that_finishes_late_gives_its_result_to_every_thread_waiting_for_it(
        self, tmp_path: Path, hang: _Hang
    ) -> None:
        probe = FolderProbe(10)
        results: list[str | None] = []
        first = threading.Thread(target=lambda: results.append(probe.problem(tmp_path)))
        first.start()
        _wait_for(lambda: len(hang.calls) == 1)
        threading.Timer(0.2, hang.release.set).start()

        # The first look is still running when this one asks.
        results.append(probe.problem(tmp_path))
        first.join(5)

        assert results == [None, None]
        assert len(hang.calls) == 1

    def test_once_the_hung_look_has_finished_the_next_one_starts_afresh(
        self, tmp_path: Path, hang: _Hang
    ) -> None:
        probe = FolderProbe(0.2)
        assert probe.problem(tmp_path) is not None
        hang.release.set()
        _wait_for(lambda: not hang.threads[0].is_alive())

        assert probe.problem(tmp_path) is None
        assert len(hang.calls) == 2

    def test_a_hung_look_at_one_folder_does_not_block_a_look_at_another(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        hung_path = tmp_path / "hung"
        release = threading.Event()
        real = models.watch_directory_problem

        def look(path: Path) -> str | None:
            if path == hung_path:
                release.wait(8)
            return real(path)

        monkeypatch.setattr(models, "watch_directory_problem", look)
        probe = FolderProbe(0.2)
        try:
            assert probe.problem(hung_path) == f"watch_directory not responding: {hung_path}"
            assert probe.problem(tmp_path) is None
        finally:
            release.set()

    def test_an_error_in_the_look_is_raised_to_the_thread_that_asked(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def broken(_path: Path) -> str | None:
            raise ValueError("embedded null byte")

        monkeypatch.setattr(models, "watch_directory_problem", broken)

        with pytest.raises(ValueError, match="embedded null byte"):
            FolderProbe(5).problem(tmp_path)

    def test_several_threads_can_ask_at_once(self, tmp_path: Path) -> None:
        probe = FolderProbe(5)
        results: list[str | None] = []
        lock = threading.Lock()

        def ask() -> None:
            answer = probe.problem(tmp_path)
            with lock:
                results.append(answer)

        threads = [threading.Thread(target=ask) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(10)

        assert results == [None] * 8


def _wait_for(condition: Any, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while not condition():
        assert time.monotonic() < deadline, "timed out waiting for the condition"
        time.sleep(0.01)
