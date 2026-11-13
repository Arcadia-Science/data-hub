"""Event reporting: how the watcher's events get to the server, and what is lost on the way.

The watcher queues events, saves them in its state database until the server has them, and
sends them in batches on each heartbeat tick. These tests are about that reporter: batching and
order, a batch that fails (kept for the next flush, or dropped when the server refuses it, with
the ``events_dropped`` event that says so), and events that were queued when the watcher was
killed.

What each event says is shown by the scenario that causes it, in the file of its machine
(``test_detection.py``, ``test_upload_auto.py``, ``test_upload_queue.py``, ``test_self_update.py``
and the others), which names the event's ``event.*`` transition in ``covers`` next to the one it
is really about. The catalog lists each event type and error kind (the kinds are listed at the
top of ``data_hub_watcher/events.py``) as an ``event.*`` transition, and the catalog check fails
if one of them has no scenario.
"""

from __future__ import annotations
from pathlib import Path

import pytest

from data_hub_shared.testing_proxy import FaultProxy, RecordedRequest
from data_hub_watcher import testing_overrides
from e2e_support.factory import WatcherFactory
from e2e_support.files import SMALL, write_run
from e2e_support.server import ServerView

pytestmark = pytest.mark.e2e


def event_posts(proxy: FaultProxy) -> list[RecordedRequest]:
    """Every request that sent events, faulted ones included."""
    return [r for r in proxy.requests if r.method == "POST" and r.path.endswith("/events")]


# ---------------------------------------------------------------------------
# The reporter
# ---------------------------------------------------------------------------


@pytest.mark.covers(
    "reporter.queue->flushed_on_heartbeat",
    "event.watcher_started->emitted",
    "event.watcher_stopped->emitted",
    "event.config_synced->emitted",
    "event.run_reported->emitted",
    "event.file_uploaded->emitted",
)
def test_events_queued_between_ticks_are_sent_together_on_the_next_one_in_order(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    # A 15-second tick leaves time to see events wait in the queue. The startup beat is
    # sent at once, and flushes what start-up queued.
    pc = watcher(overrides={testing_overrides.HEARTBEAT_INTERVAL_ENV_VAR: "15"})
    pc.start()
    started = server.wait_for_event(pc.watcher_id, event_type="watcher_started")
    assert started.message.startswith(pc.started_prefix)
    synced = server.wait_for_event(pc.watcher_id, event_type="config_synced")
    assert synced.details == {"trigger": "startup"}
    assert synced.message == "Config synced (trigger=startup)"
    seen = server.last_event_id(pc.watcher_id)
    posts = len(event_posts(proxy))

    files = write_run(watch_dir, "RUN001")
    for name, content in files.items():
        server.wait_for_uploaded(instrument_id, "RUN001", f"RUN001/{name}", content=content)

    # The run is reported and both files are uploaded, but the events about it are still in
    # the watcher's queue: nothing is sent between ticks.
    assert server.events(pc.watcher_id, after_id=seen) == []
    assert len(event_posts(proxy)) == posts

    # The next tick sends all three in one request, which the server stores in one go and
    # in the order they happened.
    batch = server.wait_for_events(pc.watcher_id, count=3, after_id=seen, timeout=45)
    assert [e.event_type for e in batch] == ["run_reported", "file_uploaded", "file_uploaded"]
    assert len({e.created_at for e in batch}) == 1
    ids = [e.id for e in batch]
    assert ids == list(range(ids[0], ids[0] + 3))
    assert len(event_posts(proxy)) == posts + 1

    reported = batch[0]
    assert reported.message == "Run RUN001 reported"
    assert reported.details == {"run_id": "RUN001"}
    by_key = {e.details["s3_key"]: e.details for e in batch[1:]}
    assert set(by_key) == {f"{instrument_id}/RUN001/{name}" for name in files}
    for name, content in files.items():
        details = by_key[f"{instrument_id}/RUN001/{name}"]
        assert details["size_bytes"] == len(content)
        assert {"sha256", "prep_seconds", "upload_seconds", "part_count"} <= set(details)

    # A stop flushes at once and says who stopped the watcher. (The watcher's own
    # `watcher_stopped` and the server's revert event share the event type, so the message
    # says which one is meant.)
    assert pc.stop() == 0
    stopped = server.wait_for_event(
        pc.watcher_id, event_type="watcher_stopped", message_contains=pc.operator_stop_message
    )
    assert stopped.message == pc.operator_stop_message


@pytest.mark.covers("reporter.flush->failed_batch_kept")
def test_a_batch_that_cannot_be_sent_stays_saved_and_the_next_flush_sends_it(
    watcher: WatcherFactory, server: ServerView, proxy: FaultProxy
) -> None:
    pc = watcher()
    # The startup flush makes three attempts and every one fails with a server error.
    with proxy.fault("status", method="POST", path=r"/events$", status=503, count=3) as refused:
        pc.start()
        assert refused.hits == 3
    # The watcher keeps running ...
    assert pc.is_running()
    server.wait_for_watcher_status(pc.watcher_id, "watching")
    # ... and the next tick sends the batch it could not send, as it was.
    server.wait_for_event(pc.watcher_id, event_type="watcher_started")
    server.wait_for_event(pc.watcher_id, event_type="config_synced")
    assert server.events(pc.watcher_id, kind="events_dropped") == []


@pytest.mark.covers(
    "reporter.flush->refused_batch_dropped",
    "reporter.dropped->reported_after_recovery",
    "event.events_dropped->emitted",
)
def test_a_batch_the_server_refuses_is_dropped_and_the_next_flush_reports_the_gap(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc = watcher()
    # The startup flush makes three attempts and every one is refused. A 4xx is not sent again
    # later: it would fail the same way, and every event queued after it would wait behind it.
    with proxy.fault("status", method="POST", path=r"/events$", status=400, count=3) as refused:
        pc.start()
        assert refused.hits == 3
    # The watcher keeps running ...
    assert pc.is_running()
    server.wait_for_watcher_status(pc.watcher_id, "watching")
    # ... and the next tick says that events were lost, and since when.
    dropped = server.wait_for_event(pc.watcher_id, event_type="error", kind="events_dropped")
    assert dropped.details["dropped_count"] == 2  # `config_synced` and `watcher_started`
    assert dropped.details["since"]
    assert dropped.message == "Dropped 2 watcher event(s) due to API errors"
    assert server.events(pc.watcher_id, event_type="watcher_started") == []

    # Events that come after it are stored normally, after the report of the gap.
    write_run(watch_dir, "RUN001", {"small.csv": SMALL})
    reported = server.wait_for_event(pc.watcher_id, event_type="run_reported")
    assert reported.id > dropped.id
    assert len(server.events(pc.watcher_id, kind="events_dropped")) == 1


@pytest.mark.covers("reporter.queued->persisted_across_kill")
def test_events_queued_before_a_kill_are_sent_after_the_restart(
    watcher: WatcherFactory, server: ServerView, instrument_id: str, watch_dir: Path
) -> None:
    # A one-minute tick, so the events about the upload are still queued when it is killed.
    pc = watcher(overrides={testing_overrides.HEARTBEAT_INTERVAL_ENV_VAR: "60"})
    pc.start()
    server.wait_for_event(pc.watcher_id, event_type="watcher_started")
    content = write_run(watch_dir, "RUN001", {"small.csv": SMALL})["small.csv"]
    server.wait_for_uploaded(instrument_id, "RUN001", "RUN001/small.csv", content=content)
    assert server.events(pc.watcher_id, event_type="run_reported") == []
    pc.kill()

    pc.write_env(overrides={testing_overrides.HEARTBEAT_INTERVAL_ENV_VAR: "2"})
    pc.start()
    # The `run_reported` and `file_uploaded` events of the first process were kept in the state
    # database and are sent by the second. Nothing else reports them: the run and the file are
    # known to the new process and are not reported again.
    server.wait_for_event(pc.watcher_id, event_type="run_reported", timeout=10)
    server.wait_for_event(pc.watcher_id, event_type="file_uploaded", timeout=10)
