"""Helpers for what a test does with the fault proxy that more than one scenario file needs.

``silence_heartbeats`` is how a test keeps a watcher's heartbeats from reaching the server
before it ages ``last_heartbeat_at`` (see ``ServerView.age_heartbeat``), so that the age it sets
is the one the test then reads.
"""

from __future__ import annotations
import time

from data_hub_shared.testing_proxy import FaultProxy, FaultRule

__all__ = ["silence_heartbeats"]


def silence_heartbeats(
    proxy: FaultProxy, watcher_id: str | None = None, *, timeout: float = 20.0
) -> FaultRule:
    """Keep the heartbeats (of one watcher, or of all of them) from reaching the server, and
    return the fault once that is certain. Remove it with ``proxy.remove_fault``.

    A process that is killed can leave a heartbeat in flight: the proxy has already forwarded
    it, and the server stores it, and refreshes ``last_heartbeat_at``, after the test has aged
    the timestamp. A watcher sends its heartbeats one at a time, so once one has been refused
    here every earlier one has been answered and none can arrive later. Call this before the
    kill, and age the heartbeat after it. A test that wants the watcher to come back puts the
    fault away before it starts it again.

    ``timeout`` is how long to wait for the first refusal, which takes up to one heartbeat
    interval. Raises ``TimeoutError`` (from the proxy) if none comes, which is the case for a
    watcher that is not running.
    """
    suffix = "/heartbeat" if watcher_id is None else f"/watchers/{watcher_id}/heartbeat"
    started = time.time()
    refusal = proxy.add_fault("status", path=rf"{suffix}$", method="POST", status=503)
    proxy.wait_for_request(
        lambda r: (
            r.method == "POST"
            and r.fault_mode == "status"
            and r.path.endswith(suffix)
            and r.timestamp >= started
        ),
        timeout=timeout,
    )
    return refusal
