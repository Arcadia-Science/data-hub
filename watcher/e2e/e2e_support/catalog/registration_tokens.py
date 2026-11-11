"""Registration, the token a watcher is bound to, deregistration and retiring an instrument.

Code: ``api_client.py``; server side ``app/api/v1/watchers/register``,
``lib/api/watchers.ts`` (``enforceWatcherBinding``, ``deregisterWatcherRow``),
``app/api/v1/tokens/[id]`` and ``app/api/v1/instruments/[instrumentId]``.
"""

from __future__ import annotations

from e2e_support.catalog.model import Transition, covered, xfail_bug

MACHINE = "registration_tokens"

TRANSITIONS: tuple[Transition, ...] = (
    covered(
        MACHINE,
        "watcher.none->registered",
        "Registering through the API, which is what `init` does, creates a `registered` "
        "watcher bound to the registering token, with its hostname.",
    ),
    covered(
        MACHINE,
        "registration.live_watcher->refused",
        "While an instrument has a watcher that is not deregistered, registering another one "
        "for it is refused with 409, and the answer names the existing watcher.",
    ),
    covered(
        MACHINE,
        "watcher.registered->claimed_by_new_token",
        "After the registering token is revoked, the first other token that checks in "
        "claims the watcher and is bound to it from then on.",
    ),
    covered(
        MACHINE,
        "token.revoked->requests_refused",
        "Revoking the watcher's token makes every watcher request answer 401, so heartbeats "
        "stop reaching the server and the watcher reads as `stale` while its process runs.",
    ),
    covered(
        MACHINE,
        "token.new_key->watcher_resumes",
        "After the key in the env file is replaced and the watcher restarted, the new token "
        "claims the watcher and heartbeats flow again.",
    ),
    covered(
        MACHINE,
        "token.other_token->forbidden",
        "A different token that is not bound to the watcher gets 403 on every call for it, "
        "so a copied key can't control another PC's watcher.",
    ),
    covered(
        MACHINE,
        "watcher.registered->deregistered",
        "Deregistering soft-deletes the watcher: `GET /watchers/:id` answers 404, its "
        "heartbeats and events are refused with 404, and deregistering it again is a "
        "conflict. (That its instrument can register a new watcher is "
        "`watcher.deregistered->reregistered_by_init`.)",
    ),
    covered(
        MACHINE,
        "watcher.deregistered->queue_reverted",
        "Deregistering reverts the instrument's queued uploads to `detected`, with an "
        "`upload_requests_cancelled` event whose reason is `watcher_deregistered`.",
    ),
    covered(
        MACHINE,
        "watcher.deregistered->reregistered_by_init",
        "After deregistration, `init` registers a new watcher for the instrument on the "
        "same PC, which keeps its upload history, so files already uploaded are not "
        "uploaded again.",
    ),
    covered(
        MACHINE,
        "instrument.active->retired",
        "Retiring the instrument sets it `inactive`, deregisters its watchers and reverts "
        "their queued uploads, with an `upload_requests_cancelled` event whose reason is "
        "`instrument_retired`.",
    ),
    xfail_bug(
        MACHINE,
        "watcher.deregistered->process_exits",
        "A running watcher that finds out it was deregistered (from the 404 of its heartbeat) "
        "stops uploading, logs a clear error and stops, instead of running on with 404s. "
        "(Today it still reports and uploads a new file of a run the server already has: "
        "only the report of a new run names the watcher, so only that is refused.) "
        "Under the CLI it exits with a non-zero code. Under the Windows service the intended "
        "outcome is that it stops and stays stopped: a deregistered watcher can never "
        "recover, so the SCM's recovery actions, which restart a service that exits with a "
        "failure, must not keep bringing it back. The shared test checks the stop and the "
        "uploads, a CLI test the exit code, and the SCM side is "
        "`service.deregistered->stays_stopped` in `test_windows_service.py`.",
        "bug-08-deregistered-watcher-keeps-running",
    ),
    xfail_bug(
        MACHINE,
        "startup.deregistered->refused",
        "Starting a watcher whose registration was deleted exits with a clear message that "
        "says to run `init` again. (A service start that is refused exits with a failure, and "
        "the SCM's recovery restarts it twice before it stays down.)",
        "bug-08-deregistered-watcher-keeps-running",
    ),
)
