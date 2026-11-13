"""Helpers for what a test does with the fault proxy that more than one scenario file needs.

``silence_heartbeats`` is how a test keeps a watcher's heartbeats from reaching the server
before it ages ``last_heartbeat_at`` (see ``ServerView.age_heartbeat``), so that the age it sets
is the one the test then reads.

``wait_for_answer`` is how a test reads ``upstream_status`` of a request after it has waited for
the server to hold the result of that request.

``stopped_heartbeats`` is how a test reads the ``status_reason`` a watcher sent on its final
heartbeat, which the server keeps only on the watcher's row, and clears when the watcher
heartbeats again.
"""

from __future__ import annotations
import json
import time
from collections.abc import Callable
from typing import Any

from data_hub_shared.testing_proxy import FaultProxy, FaultRule, RecordedRequest
from e2e_support.waiting import wait_until

__all__ = ["silence_heartbeats", "stopped_heartbeats", "wait_for_answer"]


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


def wait_for_answer(
    proxy: FaultProxy,
    select: Callable[[], list[RecordedRequest]],
    *,
    what: str,
    timeout: float = 30.0,
) -> list[RecordedRequest]:
    """Wait until the proxy has noted the server's answer to the newest request ``select``
    returns, and return what ``select`` returns then.

    The proxy logs a request when it arrives, and fills in ``upstream_status`` only after the
    server has answered. The server stores a file before it answers, so a test that has waited
    for the file can read the request while its status is still ``None``. Wait here before
    reading ``upstream_status``. Use the list that is returned, because a request read earlier
    is a snapshot that never gets the status.

    ``select`` reads ``proxy.requests`` and returns the requests the test cares about, oldest
    first. The newest of them must be one the proxy sends to the server: a request that a
    ``"status"`` fault answers never gets a status, and this wait runs out. ``what`` names the
    answer in the failure message, which lists everything the proxy has logged.
    """

    def answered() -> list[RecordedRequest] | None:
        selected = select()
        return selected if selected and selected[-1].upstream_status is not None else None

    return wait_until(
        answered,
        timeout,
        lambda: "\n".join(
            f"{r.method} {r.path} fault={r.fault_mode} upstream={r.upstream_status}"
            for r in proxy.requests
        ),
        what=f"the proxy to note {what}",
    )


def stopped_heartbeats(proxy: FaultProxy) -> list[dict[str, Any]]:
    """The bodies of the ``stopped`` heartbeats the watcher sent, oldest first.

    The server stores no ``status_reason`` with a heartbeat. It keeps one on the watcher's row,
    and clears it when the watcher heartbeats again, so a test that wants to know what the old
    process said on its final heartbeat, after the watcher was started again, reads it here. The
    proxy logs a body before it forwards the request, so a heartbeat the server has stored is
    already here.
    """
    bodies = []
    for request in proxy.requests:
        if (
            request.method == "POST"
            and request.path.split("?")[0].endswith("/heartbeat")
            and request.body is not None
        ):
            body = json.loads(request.body)
            if body.get("status") == "stopped":
                bodies.append(body)
    return bodies
