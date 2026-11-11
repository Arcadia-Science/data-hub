"""Config sync: the PC's ``config.yaml`` and the server's copy, kept in step.

The real watcher runs from a ``uv tool`` install, and every scenario drives it from outside:
``config.yaml`` edited while it is stopped or running, revisions an admin saves through the
REST routes, and faults the proxy puts on the config routes. What each test checks is what the
server holds (the watcher row, the revision history, the events) and what the PC ends up
with (``config.yaml``, the state database).

The behavior under test lives in ``WatcherSupervisor`` (``runtime.py``: the startup push,
``apply_config_revision``, the in-process rebuild) and, on the server, in
``lib/api/watcher-config/revisions.ts``. Two things worth knowing before reading a test:

* An admin can save a revision only after the watcher has sent a heartbeat, because the server
  needs to know its version. ``_start`` waits for the first heartbeat.
* The watcher reads ``config.yaml`` only at start. An edit made while it runs does nothing
  until the next start, which is intended.
"""

from __future__ import annotations
import hashlib
import json
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any, cast

import pytest

from data_hub_shared.testing_proxy import FaultProxy
from e2e_support.admin import Admin
from e2e_support.drivers import WatcherDriver
from e2e_support.factory import WatcherFactory
from e2e_support.files import payload, write_file
from e2e_support.server import ServerView, WatcherRow
from e2e_support.waiting import stays_true, wait_until

pytestmark = pytest.mark.e2e

# Where the watcher keeps a revision result the server hasn't received yet (state.py).
UNSENT_RESULT_KEY = "config_revision_unsent_result"

# Config routes, as the watcher calls them (the part after /api/v1/watchers/<id>/).
CHECKSUM_ROUTE = "config-checksum"
PUSH_ROUTE = "config"
LATEST_ROUTE = "config-revisions/latest"

# The route that takes a revision's verdict, and the route the config is pushed to. As patterns
# for the proxy, which searches the request path and query.
RESULT_PATH = r"/config-revisions/\d+/result$"
PUSH_PATH = r"/config$"
CHECKSUM_PATH = r"/config-checksum$"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _start(pc: WatcherDriver, server: ServerView) -> WatcherRow:
    """Start the watcher and wait until the server shows it watching.

    By then it has sent its first heartbeat, so the server knows its version and an admin may
    edit its config.
    """
    pc.start()
    return server.wait_for_watcher_status(pc.watcher_id, "watching")


def _edit_config(pc: WatcherDriver, **instrument: Any) -> None:
    """Change settings of the instrument in ``config.yaml``, as a person editing the file does."""
    config = pc.load_config()
    edited = config.instrument.model_copy(update=instrument)
    pc.write_config(config.model_copy(update={"instrument": edited}))


def _checksum(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


# The text of a `watcher_started` event starts with the role of the process, which the driver
# knows: "Watcher" for `data-hub-watcher watch`, "Service" for the Windows service.
def _is_start_message(pc: WatcherDriver, message: str) -> bool:
    """Whether ``message`` is the one of a plain start."""
    return message.startswith(pc.started_prefix)


def _is_restart_message(pc: WatcherDriver, message: str, revision: int) -> bool:
    """Whether ``message`` is the one of a rebuild for this config revision, in the same process."""
    pattern = rf"{re.escape(pc.restarted_prefix)}.+ with config revision {revision}"
    return re.fullmatch(pattern, message) is not None


def _running_pid(pc: WatcherDriver) -> int:
    """The pid of the running watcher. Compare it later to see that no new process was made."""
    pid = pc.pid
    assert pid is not None, "the watcher is not running"
    return pid


def _config_calls(proxy: FaultProxy, watcher_id: str) -> list[str]:
    """``METHOD route`` of each request the watcher sent to its config routes, oldest first.

    The route is the part after ``/api/v1/watchers/<id>/``, so a checksum check reads
    ``GET config-checksum`` and a push ``PUT config``.
    """
    prefix = f"/api/v1/watchers/{watcher_id}/"
    calls: list[str] = []
    for request in proxy.requests:
        path = request.path.split("?", 1)[0]
        if path.startswith(prefix) and path[len(prefix) :].startswith("config"):
            calls.append(f"{request.method} {path[len(prefix) :]}")
    return calls


def _unsent_result(pc: WatcherDriver) -> dict[str, Any] | None:
    """The revision result the watcher has kept because the server hasn't received it."""
    rows = pc.state_query("SELECT value FROM meta WHERE key = ?", (UNSENT_RESULT_KEY,))
    return json.loads(rows[0][0]) if rows else None


def _pending_upload_paths(pc: WatcherDriver) -> list[str]:
    rows = pc.state_query("SELECT relative_path FROM pending_uploads ORDER BY rowid")
    return [str(row[0]) for row in rows]


class Revisions:
    """What an admin sees and does with one watcher's config history."""

    def __init__(self, admin: Admin, server: ServerView, watcher_id: str) -> None:
        self.admin = admin
        self.server = server
        self.watcher_id = watcher_id

    def history(self) -> list[tuple[int, str, str]]:
        """``(number, source, status)`` of every revision, newest first."""
        return [
            (r["revision"], r["source"], r["status"])
            for r in self.admin.config_revisions(self.watcher_id)
        ]

    def save(self, settings: dict[str, Any]) -> dict[str, Any]:
        """Save ``settings`` as a new revision based on the latest one, and return it."""
        result = self.admin.save_config_revision(self.watcher_id, settings)
        assert result.status_code == 201, result
        return cast("dict[str, Any]", result.body)

    def wait_for(self, number: int, status: str, timeout: float = 30.0) -> dict[str, Any]:
        """Wait until the revision has this status and return it."""

        def reached() -> dict[str, Any] | None:
            revision = self.admin.config_revision(self.watcher_id, number)
            return revision if revision["status"] == status else None

        return wait_until(
            reached,
            timeout,
            lambda: f"history: {self.history()}\n{self.server.dump(self.watcher_id)}",
            what=f"config revision {number} to be {status!r}",
        )


def _wait_for_row(
    server: ServerView, watcher_id: str, what: str, check: Any, timeout: float = 30.0
) -> WatcherRow:
    """Wait until ``check(row)`` is true for the watcher's row and return the row."""

    def found() -> WatcherRow | None:
        row = server.watcher(watcher_id)
        return row if check(row) else None

    return wait_until(found, timeout, lambda: server.dump(watcher_id), what=what)


# ---------------------------------------------------------------------------
# The push at start
# ---------------------------------------------------------------------------


@pytest.mark.covers("config.startup->pushed", "event.config_synced->emitted")
def test_first_start_pushes_the_config_as_a_pc_revision(
    watcher: WatcherFactory, server: ServerView, admin: Admin, proxy: FaultProxy
) -> None:
    pc = watcher()
    # A registered watcher has no config on the server yet.
    before = server.watcher(pc.watcher_id)
    assert (before.config_checksum, before.config_yaml) == (None, None)
    assert admin.config_revisions(pc.watcher_id) == []

    _start(pc, server)

    # It asked for the server's checksum, found none, and pushed the file.
    assert _config_calls(proxy, pc.watcher_id)[:2] == [
        f"GET {CHECKSUM_ROUTE}",
        f"PUT {PUSH_ROUTE}",
    ]
    row = server.watcher(pc.watcher_id)
    assert row.config_checksum == _checksum(pc.config_path)
    assert row.config_yaml == pc.config_path.read_text(encoding="utf-8")

    # The server recorded the pushed settings as the first revision, made on the PC.
    [first] = admin.config_revisions(pc.watcher_id)
    assert (first["revision"], first["source"], first["status"]) == (1, "pc", "applied")
    assert first["settings"]["watch_directory"] == str(pc.watch_dir)
    assert first["settings"]["file_patterns"] == ["*.csv"]
    assert first["created_by_token"] is not None
    assert (row.config_revision, row.applied_config_revision) == (1, 1)

    # And the watcher said so: one `config_synced` event, with the trigger.
    [synced] = server.wait_for_events(
        pc.watcher_id, event_type="config_synced", message_contains="trigger=startup"
    )
    assert synced.details == {"trigger": "startup"}
    assert synced.message == "Config synced (trigger=startup)"


@pytest.mark.covers("config.startup->push_skipped")
def test_restart_with_an_unchanged_config_pushes_nothing(
    watcher: WatcherFactory, server: ServerView, admin: Admin, proxy: FaultProxy
) -> None:
    pc = watcher()
    _start(pc, server)
    server.wait_for_event(pc.watcher_id, event_type="config_synced")
    assert pc.stop() == 0
    server.wait_for_watcher_status(pc.watcher_id, "stopped")
    pushed = server.watcher(pc.watcher_id)
    proxy.clear_log()

    _start(pc, server)
    # Its second `watcher_started` event is queued after the sync, so by the time it is
    # stored, a `config_synced` event from this start would be too.
    server.wait_for_events(pc.watcher_id, event_type="watcher_started", count=2)

    calls = _config_calls(proxy, pc.watcher_id)
    assert f"GET {CHECKSUM_ROUTE}" in calls
    assert f"PUT {PUSH_ROUTE}" not in calls
    assert len(server.events(pc.watcher_id, event_type="config_synced")) == 1
    assert [r["revision"] for r in admin.config_revisions(pc.watcher_id)] == [1]
    assert server.watcher(pc.watcher_id).config_checksum == pushed.config_checksum


@pytest.mark.covers("config.startup->push_failed", "event.config_sync_failed->emitted")
def test_a_failed_config_sync_is_reported_and_the_watcher_still_starts(
    watcher: WatcherFactory, server: ServerView, admin: Admin, proxy: FaultProxy
) -> None:
    pc = watcher()
    config = pc.config_path.read_text(encoding="utf-8")

    # First, the checksum check fails.
    with proxy.fault("status", path=CHECKSUM_PATH, method="GET", status=503):
        row = _start(pc, server)
    assert pc.is_running()
    assert row.status == "watching"
    failed = server.wait_for_event(pc.watcher_id, event_type="error", kind="config_sync_failed")
    assert failed.message.startswith("Could not check remote config checksum")
    assert failed.details["error"]
    assert pc.stop() == 0
    assert f"PUT {PUSH_ROUTE}" not in _config_calls(proxy, pc.watcher_id), (
        "a push was attempted although the checksum check failed"
    )

    # Then the push fails: the server has no checksum for the file, so the watcher sends it.
    seen = server.last_event_id(pc.watcher_id)
    with proxy.fault("status", path=PUSH_PATH, method="PUT", status=503):
        _start(pc, server)
    assert pc.is_running()
    [push_failed] = server.wait_for_events(
        pc.watcher_id, event_type="error", kind="config_sync_failed", after_id=seen
    )
    assert push_failed.message.startswith("Could not push config to API")
    assert push_failed.details["checksum"] == _checksum(pc.config_path)
    assert pc.stop() == 0

    # Nothing reached the server in either start.
    stored = server.watcher(pc.watcher_id)
    assert (stored.config_checksum, stored.config_yaml) == (None, None)
    assert admin.config_revisions(pc.watcher_id) == []
    assert server.events(pc.watcher_id, event_type="config_synced") == []
    assert pc.config_path.read_text(encoding="utf-8") == config

    # The next start, with the server reachable, pushes it.
    _start(pc, server)
    server.wait_for_event(pc.watcher_id, event_type="config_synced", message_contains="startup")
    assert server.watcher(pc.watcher_id).config_checksum == _checksum(pc.config_path)
    assert Revisions(admin, server, pc.watcher_id).history() == [(1, "pc", "applied")]


@pytest.mark.covers("config.revision->editable_after_first_heartbeat")
def test_a_watcher_can_be_edited_from_the_web_once_its_first_heartbeat_reports_its_version(
    watcher: WatcherFactory, server: ServerView, admin: Admin
) -> None:
    """The server edits only watchers that report a version supporting config revisions."""
    pc = watcher()
    revisions = Revisions(admin, server, pc.watcher_id)
    settings = pc.revision_settings(upload_mode="manual")

    # Registered, but no heartbeat yet, so the server doesn't know its version.
    refused = admin.save_config_revision(pc.watcher_id, settings, base_revision=None)
    assert refused.status_code == 409, refused
    assert refused.body["error"]["details"]["reason"] == "watcher_update_required"

    # A version from before config revisions is refused the same way.
    server.execute("UPDATE watchers SET watcher_version = '1.3.0' WHERE id = %s", (pc.watcher_id,))
    refused = admin.save_config_revision(pc.watcher_id, settings, base_revision=None)
    assert refused.status_code == 409, refused
    assert refused.body["error"]["details"]["watcher_version"] == "1.3.0"
    assert revisions.history() == []

    # The first heartbeat of the real watcher reports its version, and then the admin may edit.
    _start(pc, server)
    created = revisions.save(settings)
    assert (created["revision"], created["status"]) == (2, "pending")
    revisions.wait_for(2, "applied")


# ---------------------------------------------------------------------------
# Edits made on the PC
# ---------------------------------------------------------------------------


@pytest.mark.covers("config.offline_edit->pushed_as_pc_revision", "event.config_synced->emitted")
def test_an_edit_made_while_stopped_is_pushed_as_a_pc_revision(
    watcher: WatcherFactory,
    server: ServerView,
    admin: Admin,
    proxy: FaultProxy,
    watch_dir: Path,
    instrument_id: str,
) -> None:
    pc = watcher()
    revisions = Revisions(admin, server, pc.watcher_id)
    _start(pc, server)
    assert pc.stop() == 0
    assert revisions.history() == [(1, "pc", "applied")]

    # Someone adds a file pattern in the file while the watcher is stopped.
    _edit_config(pc, file_patterns=["*.csv", "*.txt"])
    proxy.clear_log()
    _start(pc, server)

    # The start pushed it: a second revision, from the PC, based on the one it had applied.
    assert f"PUT {PUSH_ROUTE}" in _config_calls(proxy, pc.watcher_id)
    assert revisions.history() == [(2, "pc", "applied"), (1, "pc", "applied")]
    second = admin.config_revision(pc.watcher_id, 2)
    assert second["settings"]["file_patterns"] == ["*.csv", "*.txt"]
    assert second["created_by"] is None
    assert second["created_by_token"] is not None
    row = server.watcher(pc.watcher_id)
    assert (row.config_revision, row.applied_config_revision) == (2, 2)
    assert row.config_checksum == _checksum(pc.config_path)
    synced = server.wait_for_events(
        pc.watcher_id, event_type="config_synced", message_contains="trigger=startup", count=2
    )
    assert len(synced) == 2

    # The edit is live: a pattern the first config didn't have is now uploaded.
    notes = write_file(watch_dir / "RUN1" / "notes.txt", 300)
    server.wait_for_uploaded(instrument_id, "RUN1", "RUN1/notes.txt", content=notes)


@pytest.mark.covers(
    "config.offline_conflict->web_change_wins", "event.config_revision_applied->recorded"
)
def test_an_older_edit_on_the_pc_loses_to_a_newer_web_change(
    watcher: WatcherFactory, server: ServerView, admin: Admin, proxy: FaultProxy
) -> None:
    pc = watcher()
    revisions = Revisions(admin, server, pc.watcher_id)
    _start(pc, server)
    assert pc.stop() == 0

    # Someone edits the file on the PC, and an hour later an admin saves a change.
    web_settings = pc.revision_settings(file_patterns=["*.csv", "*.txt"])
    _edit_config(pc, file_patterns=["*.csv", "*.dat"])
    an_hour_ago = time.time() - 3600
    os.utime(pc.config_path, (an_hour_ago, an_hour_ago))
    web = revisions.save(web_settings)
    assert (web["revision"], web["status"]) == (2, "pending")
    proxy.clear_log()

    _start(pc, server)

    # The newer web change won and was applied. The PC's edit is kept in the history, above
    # it, as superseded.
    revisions.wait_for(2, "applied")
    assert revisions.history() == [
        (3, "pc", "superseded"),
        (2, "web", "applied"),
        (1, "pc", "applied"),
    ]
    superseded = admin.config_revision(pc.watcher_id, 3)
    assert superseded["settings"]["file_patterns"] == ["*.csv", "*.dat"]
    assert "revision 2" in superseded["status_reason"]
    assert pc.load_config().instrument.file_patterns == ["*.csv", "*.txt"]
    applied = server.wait_for_event(
        pc.watcher_id, event_type="config_synced", kind="config_revision_applied"
    )
    assert applied.details["revision"] == 2

    # The heartbeats announce revision 3. The watcher looks at it once (the second fetch of
    # this start, after the one that found revision 2), sees that it was superseded, and
    # neither applies nor fetches it again.
    def fetches() -> int:
        return _config_calls(proxy, pc.watcher_id).count(f"GET {LATEST_ROUTE}")

    wait_until(
        lambda: fetches() == 2,
        30,
        lambda: server.dump(pc.watcher_id),
        what="the watcher to look at the superseded revision",
    )
    stays_true(
        lambda: (
            fetches() == 2
            and revisions.history()
            == [(3, "pc", "superseded"), (2, "web", "applied"), (1, "pc", "applied")]
            and server.watcher(pc.watcher_id).applied_config_revision == 2
            and pc.load_config().instrument.file_patterns == ["*.csv", "*.txt"]
        ),
        5,
        what="the superseded revision to stay unapplied",
    )


@pytest.mark.covers("config.offline_conflict->pc_edit_wins")
def test_a_newer_edit_on_the_pc_beats_an_older_web_change(
    watcher: WatcherFactory, server: ServerView, admin: Admin
) -> None:
    pc = watcher()
    revisions = Revisions(admin, server, pc.watcher_id)
    _start(pc, server)
    assert pc.stop() == 0

    # An admin saves a change, and later someone edits the file on the PC.
    web = revisions.save(pc.revision_settings(file_patterns=["*.csv", "*.txt"]))
    assert (web["revision"], web["status"]) == (2, "pending")
    _edit_config(pc, file_patterns=["*.csv", "*.dat"])
    later = time.time() + 60
    os.utime(pc.config_path, (later, later))

    _start(pc, server)

    # The edit won: it is a new applied revision, and the web change was superseded.
    assert revisions.history() == [
        (3, "pc", "applied"),
        (2, "web", "superseded"),
        (1, "pc", "applied"),
    ]
    assert (
        "newer edit on the instrument PC"
        in admin.config_revision(pc.watcher_id, 2)["status_reason"]
    )
    assert pc.load_config().instrument.file_patterns == ["*.csv", "*.dat"]
    row = _wait_for_row(
        server, pc.watcher_id, "revision 3 to be applied", lambda r: r.applied_config_revision == 3
    )
    assert row.config_revision == 3

    # The watcher never applied the web change.
    stays_true(
        lambda: (
            server.events(pc.watcher_id, kind="config_revision_applied") == []
            and revisions.history()[1] == (2, "web", "superseded")
        ),
        4,
        what="the superseded web revision to stay unapplied",
    )


@pytest.mark.covers("config.running_edit->ignored_until_restart")
def test_an_edit_made_while_running_waits_for_the_next_start(
    watcher: WatcherFactory,
    server: ServerView,
    admin: Admin,
    watch_dir: Path,
    instrument_id: str,
) -> None:
    pc = watcher()
    revisions = Revisions(admin, server, pc.watcher_id)
    _start(pc, server)
    server.wait_for_event(pc.watcher_id, event_type="config_synced")

    # Someone adds a pattern to the file while the watcher runs.
    _edit_config(pc, file_patterns=["*.csv", "*.txt"])
    run = watch_dir / "RUN1"
    data = write_file(run / "a.csv", 300)
    notes = write_file(run / "notes.txt", 300)

    # Nothing changes: the .csv is uploaded, the .txt is not seen, and nothing is pushed.
    server.wait_for_uploaded(instrument_id, "RUN1", "RUN1/a.csv", content=data)
    stays_true(
        lambda: (
            server.file(instrument_id, "RUN1", "RUN1/notes.txt") is None
            and revisions.history() == [(1, "pc", "applied")]
            and len(server.events(pc.watcher_id, event_type="config_synced")) == 1
        ),
        4,
        what="the running watcher to ignore the edited file",
    )

    # The next start picks it up: it pushes the edit as a PC revision and uses the new pattern.
    assert pc.stop() == 0
    _start(pc, server)
    assert revisions.history() == [(2, "pc", "applied"), (1, "pc", "applied")]
    server.wait_for_uploaded(instrument_id, "RUN1", "RUN1/notes.txt", content=notes)


# ---------------------------------------------------------------------------
# Revisions from the web app
# ---------------------------------------------------------------------------


@pytest.mark.covers(
    "config.revision->applied",
    "event.config_revision_applied->recorded",
    "event.config_synced->emitted",
    "event.watcher_started->emitted",
)
def test_an_admin_revision_is_applied_by_rebuilding_in_the_same_process(
    watcher: WatcherFactory,
    server: ServerView,
    admin: Admin,
    proxy: FaultProxy,
    watch_dir: Path,
    instrument_id: str,
) -> None:
    pc = watcher()
    revisions = Revisions(admin, server, pc.watcher_id)
    _start(pc, server)
    pid = _running_pid(pc)
    proxy.clear_log()

    # An admin switches the instrument to manual uploads and adds a file pattern.
    changed = pc.revision_settings(upload_mode="manual", file_patterns=["*.csv", "*.txt"])
    created = revisions.save(changed)
    assert (created["revision"], created["status"], created["source"]) == (2, "pending", "web")

    # The next heartbeat reply carries the number; the watcher fetches the revision, applies it
    # and reports the result.
    revisions.wait_for(2, "applied")
    applied = pc.load_config().instrument
    assert (applied.upload_mode, applied.file_patterns) == ("manual", ["*.csv", "*.txt"])
    assert f"GET {LATEST_ROUTE}" in _config_calls(proxy, pc.watcher_id)
    assert any(
        r.method == "POST" and r.path.endswith("/config-revisions/2/result") for r in proxy.requests
    )

    # It took effect by rebuilding inside the same process: no stop, no restart.
    started = server.wait_for_event(
        pc.watcher_id, event_type="watcher_started", message_contains="with config revision 2"
    )
    assert _is_restart_message(pc, started.message, 2), started.message
    assert len(server.events(pc.watcher_id, event_type="watcher_started")) == 2
    assert server.events(pc.watcher_id, event_type="watcher_stopped") == []
    assert "stopped" not in [b.status for b in server.heartbeats(pc.watcher_id)]
    assert pc.pid == pid
    assert "Applying config revision 2" in pc.log_text()

    # The server recorded the result. The watcher then pushed the new file, which matched the
    # revision, so the push made no PC revision.
    done = server.wait_for_event(
        pc.watcher_id, event_type="config_synced", kind="config_revision_applied"
    )
    assert done.details["revision"] == 2
    pushed = server.wait_for_events(
        pc.watcher_id, event_type="config_synced", message_contains="trigger=config_revision"
    )
    assert [e.details for e in pushed] == [{"trigger": "config_revision"}]
    assert f"PUT {PUSH_ROUTE}" in _config_calls(proxy, pc.watcher_id)
    assert revisions.history() == [(2, "web", "applied"), (1, "pc", "applied")]

    # The heartbeat reports the applied revision. Clear it on the server so the next
    # heartbeat has to put it back.
    server.execute(
        "UPDATE watchers SET applied_config_revision = NULL WHERE id = %s", (pc.watcher_id,)
    )
    row = _wait_for_row(
        server,
        pc.watcher_id,
        "a heartbeat to report the applied revision",
        lambda r: r.applied_config_revision == 2,
    )
    assert row.config_revision == 2
    assert row.config_checksum == _checksum(pc.config_path)
    wait_until(
        lambda: server.heartbeats(pc.watcher_id)[-1].upload_mode == "manual",
        30,
        what="heartbeats to report the new upload mode",
    )

    # The rebuilt watcher runs the new settings: a .txt file now matches, and manual mode
    # leaves it detected instead of uploading it.
    write_file(watch_dir / "RUN1" / "notes.txt", 300)
    server.wait_for_file(instrument_id, "RUN1", "RUN1/notes.txt", status="detected")

    # Saving on top of a revision the admin hadn't seen is refused.
    stale = admin.save_config_revision(pc.watcher_id, changed, base_revision=1)
    assert stale.status_code == 409, stale
    assert stale.body["error"]["details"] == {"reason": "stale_revision", "latest_revision": 2}


@pytest.mark.covers("config.revision->applied_at_start", "event.config_revision_applied->recorded")
def test_a_revision_saved_while_stopped_is_applied_before_watching_starts(
    watcher: WatcherFactory,
    server: ServerView,
    admin: Admin,
    watch_dir: Path,
    instrument_id: str,
) -> None:
    pc = watcher()
    revisions = Revisions(admin, server, pc.watcher_id)
    _start(pc, server)
    assert pc.stop() == 0

    # An admin saves a change while the watcher is off, and a .json file is waiting in the folder.
    revisions.save(pc.revision_settings(file_patterns=["*.csv", "*.json"]))
    write_file(watch_dir / "RUN1" / "waiting.json", 300, mtime=time.time() - 3600)

    _start(pc, server)

    # The start applied it, and the first runtime already ran the new config: the file the
    # new pattern picks out was found by the first scan.
    revisions.wait_for(2, "applied")
    assert revisions.history() == [(2, "web", "applied"), (1, "pc", "applied")]
    assert pc.load_config().instrument.file_patterns == ["*.csv", "*.json"]
    server.wait_for_file(instrument_id, "RUN1", "RUN1/waiting.json", status="detected")

    # There was no rebuild: the watcher announces a plain start, after the revision was applied.
    started = server.wait_for_events(pc.watcher_id, event_type="watcher_started", count=2)[-1]
    assert _is_start_message(pc, started.message), started.message
    applied = server.wait_for_event(
        pc.watcher_id, event_type="config_synced", kind="config_revision_applied"
    )
    assert applied.details["revision"] == 2
    assert applied.id < started.id
    assert not any("with config revision" in e.message for e in server.events(pc.watcher_id))
    assert pc.is_running()


@pytest.mark.covers(
    "config.revision->applied_while_waiting",
    "event.watch_directory_unavailable->emitted",
    "event.watcher_started->emitted",
)
def test_a_revision_that_fixes_the_folder_ends_the_waiting_without_a_restart(
    watcher: WatcherFactory,
    server: ServerView,
    admin: Admin,
    tmp_path: Path,
    watch_dir: Path,
    instrument_id: str,
) -> None:
    # The folder the config names doesn't exist, so the watcher starts waiting.
    unplugged = tmp_path / "unplugged"
    pc = watcher(watch_dir=unplugged, create_watch_dir=False)
    revisions = Revisions(admin, server, pc.watcher_id)
    pc.start()
    pid = _running_pid(pc)
    waiting = server.wait_for_watcher_status(pc.watcher_id, "waiting")
    assert "watch_directory not found" in (waiting.status_reason or "")
    unavailable = server.wait_for_event(
        pc.watcher_id, event_type="error", kind="watch_directory_unavailable"
    )
    assert str(unplugged) in unavailable.message
    # It still pushed its config at start, so the admin has a revision to build on.
    assert revisions.history() == [(1, "pc", "applied")]

    # An admin points it at a folder that exists.
    revisions.save(pc.revision_settings(watch_directory=str(watch_dir)))

    revisions.wait_for(2, "applied")
    row = server.wait_for_watcher_status(pc.watcher_id, "watching")
    assert row.status_reason is None
    assert pc.load_config().instrument.watch_directory == watch_dir
    assert pc.pid == pid
    resumed = server.wait_for_event(
        pc.watcher_id, event_type="watcher_started", message_contains="with config revision 2"
    )
    assert _is_restart_message(pc, resumed.message, 2), resumed.message
    assert server.events(pc.watcher_id, event_type="watcher_stopped") == []

    # It watches the new folder.
    data = write_file(watch_dir / "RUN1" / "a.csv", 300)
    server.wait_for_uploaded(instrument_id, "RUN1", "RUN1/a.csv", content=data)


@pytest.mark.covers(
    "config.revision->rejected_missing_folder", "event.config_revision_rejected->recorded"
)
def test_a_revision_whose_folder_is_missing_is_rejected_and_not_fetched_again(
    watcher: WatcherFactory, server: ServerView, admin: Admin, proxy: FaultProxy, tmp_path: Path
) -> None:
    pc = watcher()
    revisions = Revisions(admin, server, pc.watcher_id)
    _start(pc, server)
    config_before = pc.config_path.read_bytes()
    missing = tmp_path / "not-there"
    proxy.clear_log()

    revisions.save(pc.revision_settings(watch_directory=str(missing)))

    # The watcher checked the folder, which only it can do, and rejected the revision with a reason.
    rejected = revisions.wait_for(2, "rejected")
    assert "watch_directory not found" in rejected["status_reason"]
    assert str(missing) in rejected["status_reason"]
    event = server.wait_for_event(
        pc.watcher_id, event_type="error", kind="config_revision_rejected"
    )
    assert event.details["revision"] == 2
    assert event.details["reason"] == rejected["status_reason"]
    assert event.message.startswith("Rejected config revision 2: ")

    # It keeps running with the old config, untouched.
    assert pc.config_path.read_bytes() == config_before
    assert pc.is_running()
    assert server.watcher(pc.watcher_id).status == "watching"
    assert len(server.events(pc.watcher_id, event_type="watcher_started")) == 1
    row = server.watcher(pc.watcher_id)
    assert (row.config_revision, row.applied_config_revision) == (2, 1)

    # The heartbeats keep announcing revision 2, but it was seen, so it isn't fetched again.
    def fetches() -> int:
        return _config_calls(proxy, pc.watcher_id).count(f"GET {LATEST_ROUTE}")

    assert fetches() == 1
    server.wait_for_heartbeats(
        pc.watcher_id, count=2, after_id=server.last_heartbeat_id(pc.watcher_id)
    )
    assert fetches() == 1
    assert revisions.history()[0] == (2, "web", "rejected")


@pytest.mark.covers("config.revision->no_rebuild_when_unchanged")
def test_a_revision_equal_to_the_running_settings_is_applied_without_a_rebuild(
    watcher: WatcherFactory, server: ServerView, admin: Admin, proxy: FaultProxy, tmp_path: Path
) -> None:
    pc = watcher()
    revisions = Revisions(admin, server, pc.watcher_id)
    _start(pc, server)
    pid = _running_pid(pc)
    running = pc.revision_settings()
    config_before = pc.config_path.read_bytes()

    # The server refuses a save that changes nothing, so first get a revision rejected: after a
    # rejection, saving the settings the watcher kept is a change worth recording.
    unchanged = admin.save_config_revision(pc.watcher_id, running)
    assert unchanged.status_code == 400, unchanged
    revisions.save(pc.revision_settings(watch_directory=str(tmp_path / "not-there")))
    revisions.wait_for(2, "rejected")
    proxy.clear_log()
    revisions.save(running)

    revisions.wait_for(3, "applied")
    assert revisions.history() == [
        (3, "web", "applied"),
        (2, "web", "rejected"),
        (1, "pc", "applied"),
    ]
    done = server.wait_for_events(
        pc.watcher_id, event_type="config_synced", kind="config_revision_applied"
    )
    assert [e.details["revision"] for e in done] == [3]
    row = _wait_for_row(
        server,
        pc.watcher_id,
        "the applied revision to show",
        lambda r: r.applied_config_revision == 3,
    )
    assert row.config_revision == 3

    # No rebuild: one `watcher_started` event, no stop, the same process, the file untouched,
    # and no push of a new file.
    assert len(server.events(pc.watcher_id, event_type="watcher_started")) == 1
    assert server.events(pc.watcher_id, event_type="watcher_stopped") == []
    assert "stopped" not in [b.status for b in server.heartbeats(pc.watcher_id)]
    assert pc.pid == pid
    assert "Applying config revision 3" not in pc.log_text()
    assert pc.config_path.read_bytes() == config_before
    assert f"PUT {PUSH_ROUTE}" not in _config_calls(proxy, pc.watcher_id)


@pytest.mark.covers("config.revision->no_rebuild_file_rewritten")
def test_a_revision_equal_to_the_running_settings_overwrites_an_unapplied_edit_of_the_file(
    watcher: WatcherFactory,
    server: ServerView,
    admin: Admin,
    proxy: FaultProxy,
    watch_dir: Path,
    instrument_id: str,
) -> None:
    pc = watcher()
    revisions = Revisions(admin, server, pc.watcher_id)
    # The first push fails, so the server has no copy of the file. (A push that finds the
    # server's copy equal to the rewritten file is skipped, and this test is about the push.)
    with proxy.fault("status", path=PUSH_PATH, method="PUT", status=503):
        _start(pc, server)
        server.wait_for_event(pc.watcher_id, event_type="error", kind="config_sync_failed")
    pid = _running_pid(pc)
    running = pc.revision_settings()
    running_file = pc.config_path.read_bytes()
    assert server.watcher(pc.watcher_id).config_yaml is None

    # Someone edits the file while the watcher runs. It reads the file only at start, so the edit
    # is not running.
    _edit_config(pc, file_patterns=["*.csv", "*.txt"])
    assert pc.config_path.read_bytes() != running_file
    proxy.clear_log()

    # An admin saves the settings that are running. The server takes it (it has no copy of the
    # file to compare with), and the watcher finds that it needs no rebuild.
    revisions.save(running)
    revisions.wait_for(1, "applied")

    # It saved the running settings over the edit, so the edit won't come back at the next
    # restart, and pushed the file.
    assert pc.config_path.read_bytes() == running_file
    assert pc.load_config().instrument.file_patterns == ["*.csv"]
    pushed = server.wait_for_events(
        pc.watcher_id, event_type="config_synced", message_contains="trigger=config_revision"
    )
    assert [e.details for e in pushed] == [{"trigger": "config_revision"}]
    assert _config_calls(proxy, pc.watcher_id).count(f"PUT {PUSH_ROUTE}") == 1
    row = server.watcher(pc.watcher_id)
    assert row.config_yaml == running_file.decode("utf-8")
    assert row.config_checksum == _checksum(pc.config_path)
    # The push made no `pc` revision: it is the file of revision 1, which the admin saved.
    assert revisions.history() == [(1, "web", "applied")]
    _wait_for_row(
        server,
        pc.watcher_id,
        "the applied revision to show",
        lambda r: r.applied_config_revision == 1,
    )

    # No rebuild: the same process, one start event, no stop.
    assert pc.pid == pid
    assert len(server.events(pc.watcher_id, event_type="watcher_started")) == 1
    assert server.events(pc.watcher_id, event_type="watcher_stopped") == []
    assert "Applying config revision" not in pc.log_text()

    # And the edit stays gone after a restart: nothing to push, and a .txt isn't picked up.
    assert pc.stop() == 0
    proxy.clear_log()
    _start(pc, server)
    server.wait_for_events(pc.watcher_id, event_type="watcher_started", count=2)
    assert pc.load_config().instrument.file_patterns == ["*.csv"]
    assert f"PUT {PUSH_ROUTE}" not in _config_calls(proxy, pc.watcher_id)
    assert revisions.history() == [(1, "web", "applied")]
    write_file(watch_dir / "RUN1" / "notes.txt", 300)
    data = write_file(watch_dir / "RUN1" / "a.csv", 300)  # Written last, so it is the barrier.
    server.wait_for_uploaded(instrument_id, "RUN1", "RUN1/a.csv", content=data)
    assert server.file(instrument_id, "RUN1", "RUN1/notes.txt") is None


@pytest.mark.covers(
    "config.revision->rejected_foreign_config_file", "event.config_revision_rejected->recorded"
)
def test_a_revision_is_rejected_when_the_config_file_now_belongs_to_another_watcher(
    watcher: WatcherFactory, server: ServerView, admin: Admin
) -> None:
    pc = watcher()
    revisions = Revisions(admin, server, pc.watcher_id)
    _start(pc, server)
    pid = _running_pid(pc)
    config = pc.load_config()

    # Someone on the PC points config.yaml at another watcher, as `config set-environment` does
    # for another deployment, and the watcher has not been restarted.
    pc.write_config(
        config.model_copy(update={"watcher_ids": {config.environment: str(uuid.uuid4())}})
    )
    foreign_file = pc.config_path.read_bytes()

    # An admin changes a setting.
    revisions.save(pc.revision_settings(upload_mode="manual"))

    rejected = revisions.wait_for(2, "rejected")
    assert "different environment, watcher or instrument" in rejected["status_reason"]
    event = server.wait_for_event(
        pc.watcher_id, event_type="error", kind="config_revision_rejected"
    )
    assert event.details["revision"] == 2
    assert event.details["reason"] == rejected["status_reason"]

    # The file was not written over, and the watcher carries on with its old config.
    assert pc.config_path.read_bytes() == foreign_file
    assert pc.pid == pid
    assert len(server.events(pc.watcher_id, event_type="watcher_started")) == 1
    assert server.events(pc.watcher_id, event_type="watcher_stopped") == []
    assert server.heartbeats(pc.watcher_id)[-1].upload_mode == "auto"
    row = server.watcher(pc.watcher_id)
    assert (row.status, row.config_revision, row.applied_config_revision) == ("watching", 2, 1)


@pytest.mark.covers("config.revision->result_retried", "event.config_sync_failed->emitted")
def test_a_revision_result_the_server_missed_is_sent_after_the_next_heartbeat(
    watcher: WatcherFactory, server: ServerView, admin: Admin, proxy: FaultProxy
) -> None:
    pc = watcher()
    revisions = Revisions(admin, server, pc.watcher_id)
    _start(pc, server)
    pid = _running_pid(pc)

    # The watcher applies a revision, but neither its result nor the push of the new file
    # (which would show the server that it applied it) gets through.
    with (
        proxy.fault("status", path=RESULT_PATH, method="POST", status=503),
        proxy.fault("status", path=PUSH_PATH, method="PUT", status=503),
    ):
        revisions.save(pc.revision_settings(upload_mode="manual"))
        _wait_for_row(
            server,
            pc.watcher_id,
            "the heartbeat to report revision 2",
            lambda r: r.applied_config_revision == 2,
        )

        # It applied the revision, and kept the result because the server never got it.
        assert pc.load_config().instrument.upload_mode == "manual"
        assert admin.config_revision(pc.watcher_id, 2)["status"] == "pending"
        kept = wait_until(lambda: _unsent_result(pc), 15, what="the watcher to keep the result")
        assert kept == {"revision": 2, "status": "applied", "reason": None}
        server.wait_for_event(pc.watcher_id, event_type="error", kind="config_sync_failed")
        assert pc.is_running()

    # Once the server is reachable again, the next heartbeat makes it send the result.
    revisions.wait_for(2, "applied")
    wait_until(lambda: _unsent_result(pc) is None, 15, what="the kept result to be cleared")
    done = server.wait_for_event(
        pc.watcher_id, event_type="config_synced", kind="config_revision_applied"
    )
    assert done.details["revision"] == 2
    assert pc.pid == pid


@pytest.mark.covers("config.revision->result_retried")
def test_a_revision_result_the_server_missed_is_sent_after_a_restart(
    watcher: WatcherFactory, server: ServerView, admin: Admin, proxy: FaultProxy
) -> None:
    pc = watcher()
    revisions = Revisions(admin, server, pc.watcher_id)
    _start(pc, server)

    with (
        proxy.fault("status", path=RESULT_PATH, method="POST", status=503),
        proxy.fault("status", path=PUSH_PATH, method="PUT", status=503),
    ):
        revisions.save(pc.revision_settings(upload_mode="manual"))
        _wait_for_row(
            server,
            pc.watcher_id,
            "the heartbeat to report revision 2",
            lambda r: r.applied_config_revision == 2,
        )
        wait_until(lambda: _unsent_result(pc), 15, what="the watcher to keep the result")
        # The PC is switched off before the server comes back.
        assert pc.stop() == 0

    # The result is still on the PC, and the server still thinks the change is pending.
    assert _unsent_result(pc) == {"revision": 2, "status": "applied", "reason": None}
    assert admin.config_revision(pc.watcher_id, 2)["status"] == "pending"

    # The next start sends it. Heartbeats are kept from getting through meanwhile, so it can
    # only be the start that does it, not the first heartbeat.
    with proxy.fault("status", path=r"/heartbeat$", method="POST", status=503):
        pc.start()
        revisions.wait_for(2, "applied")
        wait_until(lambda: _unsent_result(pc) is None, 15, what="the kept result to be cleared")
    server.wait_for_watcher_status(pc.watcher_id, "watching")
    assert revisions.history() == [(2, "web", "applied"), (1, "pc", "applied")]
    done = server.wait_for_event(
        pc.watcher_id, event_type="config_synced", kind="config_revision_applied"
    )
    assert done.details["revision"] == 2
    assert pc.load_config().instrument.upload_mode == "manual"


@pytest.mark.covers(
    "config.folder_change->pending_uploads_cleared",
    "config.folder_change->queue_reverted",
    "event.upload_requests_cancelled->recorded",
)
def test_changing_the_watch_folder_drops_pending_uploads_and_reverts_the_queue(
    watcher: WatcherFactory,
    server: ServerView,
    admin: Admin,
    proxy: FaultProxy,
    tmp_path: Path,
    watch_dir: Path,
    instrument_id: str,
) -> None:
    pc = watcher()
    revisions = Revisions(admin, server, pc.watcher_id)
    new_dir = (tmp_path / "moved").resolve()
    new_dir.mkdir()
    _start(pc, server)

    # Uploads can't get a URL, and the queue can't be read, so a file stays unfinished on the
    # PC (a `pending_uploads` row) and a request for it stays queued on the server.
    with (
        proxy.fault("status", path=r"/request-upload-url$", method="POST", status=503),
        proxy.fault("status", path=r"/upload-queue$", method="GET", status=503),
    ):
        write_file(watch_dir / "RUN1" / "a.csv", 300)
        detected = server.wait_for_file(instrument_id, "RUN1", "RUN1/a.csv", status="detected")
        wait_until(
            lambda: _pending_upload_paths(pc) == ["RUN1/a.csv"],
            15,
            what="the file to be a pending upload",
        )
        assert admin.request_upload(instrument_id, "RUN1", [detected.id]).status_code == 200
        queued = server.wait_for_file(
            instrument_id, "RUN1", "RUN1/a.csv", status="upload_requested"
        )
        assert queued.upload_requested_at is not None

        # An admin moves the watcher to another folder.
        revisions.save(pc.revision_settings(watch_directory=str(new_dir)))
        revisions.wait_for(2, "applied")

        # The watcher dropped the rows that point into the old folder.
        assert _pending_upload_paths(pc) == []
        assert pc.load_config().instrument.watch_directory == new_dir

        # The server took the request back out of the queue, and said so.
        reverted = server.wait_for_file(instrument_id, "RUN1", "RUN1/a.csv", status="detected")
        assert reverted.upload_requested_at is None
        cancelled = server.wait_for_event(
            pc.watcher_id, event_type="config_synced", kind="upload_requests_cancelled"
        )
        assert cancelled.details["cancelled_count"] == 1
        assert cancelled.details["previous_watch_directory"] == str(watch_dir)
        assert cancelled.details["watch_directory"] == str(new_dir)

    # With the server reachable again, nothing is retried against the new folder. The new
    # runtime retries its pending uploads before it polls the queue, so once a poll got through
    # (and the events of that time had a heartbeat to leave on), a row that had been left over
    # would have raised `pending_upload_missing` by now, and a queued request `queued_file_missing`.
    applied_at = time.time()
    proxy.wait_for_request(
        lambda r: (
            r.method == "GET"
            and r.path.endswith("/upload-queue")
            and r.fault_mode is None
            and r.timestamp > applied_at
        ),
        30,
    )
    server.wait_for_heartbeats(
        pc.watcher_id, count=2, after_id=server.last_heartbeat_id(pc.watcher_id)
    )
    assert server.upload_queue(pc.watcher_id) == []
    left = server.file(instrument_id, "RUN1", "RUN1/a.csv", include_deleted=False)
    assert left is not None and left.status == "detected"
    assert server.events(pc.watcher_id, kind="pending_upload_missing") == []
    assert server.events(pc.watcher_id, kind="queued_file_missing") == []
    assert _pending_upload_paths(pc) == []

    # And the watcher works in the new folder.
    data = write_file(new_dir / "RUN2" / "b.csv", 300)
    server.wait_for_uploaded(instrument_id, "RUN2", "RUN2/b.csv", content=data)


@pytest.mark.covers(
    "config.folder_change->queue_drained_when_push_fails",
    "config.folder_change->pending_uploads_cleared",
    "event.config_sync_failed->emitted",
    "event.queued_file_missing->emitted",
    "event.upload_request_cancelled->emitted",
)
def test_a_folder_change_whose_push_fails_still_drains_the_queue_through_the_poll(
    watcher: WatcherFactory,
    server: ServerView,
    admin: Admin,
    proxy: FaultProxy,
    tmp_path: Path,
    watch_dir: Path,
    instrument_id: str,
) -> None:
    pc = watcher()
    revisions = Revisions(admin, server, pc.watcher_id)
    new_dir = (tmp_path / "moved").resolve()
    new_dir.mkdir()
    _start(pc, server)

    # A file is unfinished on the PC (a `pending_uploads` row) and queued on the server, and the
    # queue can't be read, so it stays queued.
    with (
        proxy.fault("status", path=r"/request-upload-url$", method="POST", status=503),
        proxy.fault("status", path=r"/upload-queue$", method="GET", status=503),
    ):
        write_file(watch_dir / "RUN1" / "a.csv", 300)
        detected = server.wait_for_file(instrument_id, "RUN1", "RUN1/a.csv", status="detected")
        wait_until(
            lambda: _pending_upload_paths(pc) == ["RUN1/a.csv"],
            15,
            what="the file to be a pending upload",
        )
        assert admin.request_upload(instrument_id, "RUN1", [detected.id]).status_code == 200
        server.wait_for_file(instrument_id, "RUN1", "RUN1/a.csv", status="upload_requested")
        seen = server.last_event_id(pc.watcher_id)

        # An admin moves the watcher to another folder, and the push of the new file fails.
        with proxy.fault("status", path=PUSH_PATH, method="PUT", status=503):
            revisions.save(pc.revision_settings(watch_directory=str(new_dir)))
            revisions.wait_for(2, "applied")
            failed = server.wait_for_event(
                pc.watcher_id, event_type="error", kind="config_sync_failed", after_id=seen
            )
            assert failed.message.startswith("Could not push config to API")

        # The watcher dropped its own rows, but the server's revert is part of the push, so the
        # request is still queued, and the server still holds the old folder.
        assert _pending_upload_paths(pc) == []
        assert pc.load_config().instrument.watch_directory == new_dir
        still_queued = server.file(instrument_id, "RUN1", "RUN1/a.csv")
        assert still_queued is not None and still_queued.status == "upload_requested"
        assert server.events(pc.watcher_id, kind="upload_requests_cancelled") == []
        assert str(watch_dir) in (server.watcher(pc.watcher_id).config_yaml or "")

    # With the queue readable again, the poll finds the file missing from the new folder, and
    # after three polls cancels the request, which sends the file back to `detected`.
    reverted = server.wait_for_file(
        instrument_id, "RUN1", "RUN1/a.csv", status="detected", timeout=60
    )
    assert reverted.upload_requested_at is None
    missing = server.wait_for_events(pc.watcher_id, event_type="error", kind="queued_file_missing")
    assert {e.details["file_id"] for e in missing} == {detected.id}
    [cancelled] = server.wait_for_events(
        pc.watcher_id, event_type="error", kind="upload_request_cancelled"
    )
    assert cancelled.details["file_id"] == detected.id
    # The queue was drained by the poll's cancel, not by a revert that came with a push.
    assert server.events(pc.watcher_id, kind="upload_requests_cancelled") == []
    assert server.upload_queue(pc.watcher_id) == []


@pytest.mark.covers("config.scope_widened->report_only_scan")
def test_a_wider_scope_reports_old_files_without_uploading_them(
    watcher: WatcherFactory,
    server: ServerView,
    admin: Admin,
    watch_dir: Path,
    instrument_id: str,
) -> None:
    pc = watcher()
    revisions = Revisions(admin, server, pc.watcher_id)
    _start(pc, server)

    # A .csv is uploaded as usual. A .txt that has been in the folder for a while matches no
    # pattern yet, so the watcher ignores it.
    run = watch_dir / "RUN1"
    old = write_file(run / "old.txt", payload(300, seed=1), mtime=time.time() - 3600)
    data = write_file(run / "a.csv", 300)
    server.wait_for_uploaded(instrument_id, "RUN1", "RUN1/a.csv", content=data)
    assert server.file(instrument_id, "RUN1", "RUN1/old.txt") is None

    # An admin adds *.txt. The file is reported, but in auto mode it is not uploaded.
    revisions.save(pc.revision_settings(file_patterns=["*.csv", "*.txt"]))
    revisions.wait_for(2, "applied")
    old_row = server.wait_for_file(instrument_id, "RUN1", "RUN1/old.txt", status="detected")

    # A file written after the change follows upload_mode, which is auto.
    fresh = write_file(run / "new.txt", payload(300, seed=2))
    server.wait_for_uploaded(instrument_id, "RUN1", "RUN1/new.txt", content=fresh)
    stored = server.file(instrument_id, "RUN1", "RUN1/old.txt")
    assert stored is not None and stored.status == "detected"
    assert not server.object_exists(instrument_id, "RUN1", "old.txt")

    # It waits for someone to ask for it.
    assert admin.request_upload(instrument_id, "RUN1", [old_row.id]).status_code == 200
    server.wait_for_uploaded(instrument_id, "RUN1", "RUN1/old.txt", content=old)


# ---------------------------------------------------------------------------
# More about results and rebuilds
# ---------------------------------------------------------------------------


@pytest.mark.covers("config.revision->settled_by_push")
def test_the_push_after_applying_proves_a_revision_whose_result_was_lost(
    watcher: WatcherFactory, server: ServerView, admin: Admin, proxy: FaultProxy
) -> None:
    """The pushed file says which revision it is based on, so it settles a lost result."""
    pc = watcher()
    revisions = Revisions(admin, server, pc.watcher_id)
    _start(pc, server)

    with proxy.fault("status", path=RESULT_PATH, method="POST", status=503):
        revisions.save(pc.revision_settings(upload_mode="manual"))

        # The result never arrives, but the push that follows the apply carries the file and
        # says it is based on revision 2, which proves to the server that it was applied.
        revisions.wait_for(2, "applied")
        wait_until(lambda: _unsent_result(pc), 15, what="the watcher to keep the result")
        applied = server.wait_for_event(
            pc.watcher_id, event_type="config_synced", kind="config_revision_applied"
        )
        assert applied.details["revision"] == 2

    # When the server is reachable the result is sent too. It changes nothing: the history
    # has no extra revision from the push, and the event isn't recorded twice.
    wait_until(lambda: _unsent_result(pc) is None, 15, what="the kept result to be cleared")
    server.wait_for_heartbeats(
        pc.watcher_id, count=2, after_id=server.last_heartbeat_id(pc.watcher_id)
    )
    assert revisions.history() == [(2, "web", "applied"), (1, "pc", "applied")]
    assert len(server.events(pc.watcher_id, kind="config_revision_applied")) == 1


@pytest.mark.covers("config.rebuild_same_folder->pending_uploads_kept")
def test_a_rebuild_in_the_same_folder_keeps_the_pending_uploads(
    watcher: WatcherFactory,
    server: ServerView,
    admin: Admin,
    proxy: FaultProxy,
    watch_dir: Path,
    instrument_id: str,
) -> None:
    """Only a change of folder drops the pending uploads (the other half of that scenario)."""
    pc = watcher()
    revisions = Revisions(admin, server, pc.watcher_id)
    _start(pc, server)

    # An upload fails because no URL can be had, and stays pending.
    with proxy.fault("status", path=r"/request-upload-url$", method="POST", status=503):
        data = write_file(watch_dir / "RUN1" / "a.csv", 300)
        server.wait_for_file(instrument_id, "RUN1", "RUN1/a.csv", status="detected")
        wait_until(
            lambda: _pending_upload_paths(pc) == ["RUN1/a.csv"],
            15,
            what="the file to be a pending upload",
        )

    # A revision that leaves the folder alone rebuilds the runtime, which retries the upload.
    revisions.save(pc.revision_settings(stability_period_seconds=2))
    revisions.wait_for(2, "applied")
    server.wait_for_uploaded(instrument_id, "RUN1", "RUN1/a.csv", content=data)
    wait_until(lambda: _pending_upload_paths(pc) == [], 15, what="the pending row to be cleared")
