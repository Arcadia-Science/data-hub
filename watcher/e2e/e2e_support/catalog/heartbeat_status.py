"""Heartbeats and the status the server shows for a watcher.

Code: ``heartbeat.py`` (``HeartbeatLoop``, ``WatcherCounters``); server side
``app/api/v1/watchers/[watcherId]/heartbeat`` and ``lib/api/watchers.ts``
(``computeEffectiveStatus``, which adds ``stale`` after five minutes without a heartbeat).
The suite ages ``last_heartbeat_at`` instead of waiting for the server's timers.
"""

from __future__ import annotations

from e2e_support.catalog.model import Transition, covered, excluded, xfail_bug

MACHINE = "heartbeat_status"

TRANSITIONS: tuple[Transition, ...] = (
    covered(
        MACHINE,
        "watcher.registered->watching",
        "A registered watcher shows `registered` until it starts; its first heartbeat makes "
        "it `watching`, sets `last_heartbeat_at` and records the watcher version.",
    ),
    covered(
        MACHINE,
        "watcher.registered->never_stale",
        "A watcher that has never sent a heartbeat stays `registered` however old its "
        "timestamps are, because that status is exempt from staleness.",
    ),
    covered(
        MACHINE,
        "heartbeat.tick->recorded",
        "A running watcher keeps sending heartbeats at the configured interval, each stored "
        "with its status, upload mode and a growing uptime.",
    ),
    covered(
        MACHINE,
        "watcher.watching->stale",
        "When `last_heartbeat_at` is more than five minutes old the server reports the "
        "watcher as `stale` without changing its stored status.",
    ),
    covered(
        MACHINE,
        "watcher.stale->watching",
        "A stale watcher that is still running reads as `watching` again as soon as its "
        "next heartbeat arrives.",
    ),
    covered(
        MACHINE,
        "watcher.watching->stopped",
        "A graceful stop sends a final `stopped` heartbeat, and the server shows `stopped`.",
    ),
    covered(
        MACHINE,
        "watcher.stopped->watching",
        "Starting a stopped watcher again makes it `watching` again.",
    ),
    xfail_bug(
        MACHINE,
        "watcher.stopped->stays_stopped",
        "A watcher that stopped cleanly keeps reading `stopped` however old its last "
        "heartbeat gets, because it can't send another one. It does not turn `stale` "
        "(`Unresponsive`), which is for a watcher that went quiet without saying so.",
        "bug-new-stopped-reads-stale",
    ),
    covered(
        MACHINE,
        "watcher.waiting->reason_recorded",
        "A waiting watcher's heartbeats store the `waiting` status and its `status_reason`.",
    ),
    covered(
        MACHINE,
        "watcher.waiting->reason_cleared",
        "When the watcher resumes, its status goes back to `watching` and the stored "
        "reason is cleared.",
    ),
    covered(
        MACHINE,
        "heartbeat.counters->reported_and_reset",
        "Each heartbeat reports the files uploaded, runs reported and errors since the "
        "previous one, and the next heartbeat starts counting from zero.",
    ),
    xfail_bug(
        MACHINE,
        "heartbeat.failed->counts_carried",
        "The counts from a heartbeat that failed to send are added to the next successful "
        "heartbeat instead of being lost.",
        "bug-03-failed-heartbeat-counts-lost",
    ),
    xfail_bug(
        MACHINE,
        "heartbeat.in_flight->counts_kept",
        "A count added while a heartbeat request is in flight (a file uploaded during a "
        "slow heartbeat) is reported by the next heartbeat instead of being reset away "
        "when the request returns.",
        "bug-new-counts-lost-during-heartbeat",
    ),
    covered(
        MACHINE,
        "heartbeat.outage->watcher_survives",
        "While the server is unreachable the watcher keeps running and keeps trying, and "
        "its heartbeats are stored again when the server is back.",
    ),
    covered(
        MACHINE,
        "heartbeat.outage->recovery_event",
        "The first successful heartbeat after failures queues a `heartbeat_recovered` "
        "event with the number of failures and the length of the gap.",
    ),
    covered(
        MACHINE,
        "heartbeat.below_minimum_version->rejected",
        "With `min_supported_version` above the watcher's version, the server answers every "
        "heartbeat with 426 and stores none.",
    ),
    covered(
        MACHINE,
        "watcher.below_minimum_version->stale",
        "A watcher that had checked in and is then refused with 426 stops refreshing "
        "`last_heartbeat_at`, so it reads as `stale` once that is five minutes old, while "
        "its process keeps running.",
    ),
    excluded(
        MACHINE,
        "ui.watchers_page->rendered",
        "The Watchers page and the dashboard show the status, the reason and the events.",
        "The web UI is outside the end-to-end boundary. The suite checks the data the "
        "pages are built from.",
    ),
)
