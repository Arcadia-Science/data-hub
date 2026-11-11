"""Registration, the token a watcher is bound to, deregistration and retiring an instrument.

Each scenario registers a watcher through ``init`` or the API, or runs a real
``data-hub-watcher``, and then changes what the server knows from outside: an admin revokes a
token, deregisters a watcher or retires the instrument, or a request arrives with another
token. The transitions are in ``catalog/registration_tokens.py``.

The two ``xfail`` tests are known bug 08: a watcher whose registration was deleted keeps
running with 404s, and starting one does not refuse. They assert the intended behavior.
"""

from __future__ import annotations
import re
from pathlib import Path

import pytest

from data_hub_shared.testing_proxy import FaultProxy
from e2e_support._http import ApiResult, call, new_session
from e2e_support.admin import Admin
from e2e_support.drivers import InitAnswers, RunDetection, WatcherDriver
from e2e_support.factory import WatcherFactory
from e2e_support.files import SMALL, write_file
from e2e_support.server import FileRow, ServerView
from e2e_support.waiting import KnownBugStillPresent, known_bug, stays_true, wait_until

pytestmark = pytest.mark.e2e

# How long a refusal or an exit may take. A heartbeat is 2 s in the suite, so a correct
# watcher reacts within a few ticks.
REACTION_SECONDS = 20.0


def _post(server: ServerView, path: str, token: str, body: object) -> ApiResult:
    """``POST`` a watcher route as ``token``, and return the answer whatever it is."""
    return call(
        new_session(),
        "POST",
        f"{server.env.base_url}{path}",
        headers={"Authorization": f"Bearer {token}"},
        json=body,
    )


def _init_answers(
    pc: WatcherDriver,
    proxy: FaultProxy,
    watch_dir: Path,
    *,
    api_key: str | None = None,
    use_saved_key: bool | None = None,
    overwrite_config: bool | None = None,
) -> InitAnswers:
    """What a person types into ``init`` for the test's one instrument."""
    return InitAnswers(
        environment=pc.environment,
        api_base_url=f"{proxy.base_url}/api/v1",
        api_key=api_key,
        use_saved_key=use_saved_key,
        overwrite_config=overwrite_config,
        watch_directory=watch_dir,
        instrument=1,
        existing_instruments=1,
        file_patterns=["*.csv"],
        run_detection=RunDetection.TOP_SUBDIRECTORY,
        recursive=True,
        stability_period_seconds=1,
        upload_mode="auto",
    )


def _start_with_queued_upload(
    watcher: WatcherFactory,
    server: ServerView,
    admin: Admin,
    proxy: FaultProxy,
    instrument_id: str,
    watch_dir: Path,
) -> tuple[WatcherDriver, FileRow]:
    """A watching PC in manual mode whose one file has an upload requested.

    The watcher's queue polls are refused from here on, so the request stays in the queue
    and the file is not uploaded before the test changes the registration.
    """
    pc = watcher(upload_mode="manual")
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "watching")
    write_file(watch_dir / "RUN001" / "small.csv", SMALL)
    detected = server.wait_for_file(instrument_id, "RUN001", "RUN001/small.csv", status="detected")
    proxy.add_fault("status", path=r"/upload-queue", status=503)
    admin.request_upload(instrument_id, "RUN001", [detected.id]).raise_for_status()
    queued = server.wait_for_file(
        instrument_id, "RUN001", "RUN001/small.csv", status="upload_requested"
    )
    return pc, queued


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------


@pytest.mark.covers("watcher.none->registered")
def test_init_registers_a_watcher_bound_to_the_key_it_was_given(
    watcher: WatcherFactory,
    server: ServerView,
    admin: Admin,
    proxy: FaultProxy,
    watch_dir: Path,
    watcher_token: str,
    instrument_id: str,
) -> None:
    pc = watcher(configure=False)

    result = pc.init_interactive(_init_answers(pc, proxy, watch_dir, api_key=watcher_token))
    assert result.returncode == 0, result.output

    row = server.watcher(pc.watcher_id)
    assert (row.status, row.last_heartbeat_at, row.deleted_at) == ("registered", None, None)
    assert row.instrument_id == instrument_id
    assert row.hostname
    assert row.registered_by_token == admin.token_id(watcher_token)
    assert server.effective_status(pc.watcher_id) == "registered"


@pytest.mark.covers("registration.live_watcher->refused")
def test_a_second_registration_for_an_instrument_with_a_live_watcher_is_refused(
    watcher: WatcherFactory,
    server: ServerView,
    proxy: FaultProxy,
    watch_dir: Path,
    watcher_token: str,
    instrument_id: str,
) -> None:
    first = watcher()
    second = watcher(configure=False)

    result = second.init_interactive(_init_answers(second, proxy, watch_dir, api_key=watcher_token))

    assert result.returncode != 0, result.output
    assert "already has an active watcher" in result.output
    assert first.watcher_id in result.output
    # The refused PC writes no config, and the instrument still has only the first watcher.
    assert not second.config_path.exists()
    live = server.query(
        "SELECT id::text FROM watchers WHERE instrument_id = %s AND deleted_at IS NULL",
        (instrument_id,),
    )
    assert live == [(first.watcher_id,)]


# ---------------------------------------------------------------------------
# Tokens
# ---------------------------------------------------------------------------


@pytest.mark.covers("token.revoked->requests_refused")
def test_a_revoked_token_is_refused_and_the_running_watcher_goes_stale(
    watcher: WatcherFactory,
    server: ServerView,
    admin: Admin,
    proxy: FaultProxy,
    watcher_token: str,
) -> None:
    pc = watcher()
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "watching")

    admin.revoke_token(watcher_token).raise_for_status()

    refused = server.get(f"/api/v1/watchers/{pc.watcher_id}/upload-queue", token=watcher_token)
    assert refused.status_code == 401, refused
    # The watcher's own heartbeat is refused the same way, and the process keeps running.
    proxy.wait_for_request(
        lambda r: r.method == "POST" and r.path.endswith("/heartbeat") and r.upstream_status == 401,
        timeout=REACTION_SECONDS,
    )
    pc.wait_for_log("Heartbeat failed")
    assert pc.is_running()

    # Every heartbeat since the revocation was refused, so the server's last heartbeat is old.
    # Age it past the five-minute mark rather than waiting for it.
    server.age_past_stale(pc.watcher_id)
    server.wait_for_effective_status(pc.watcher_id, "stale")
    assert pc.is_running()


@pytest.mark.covers("token.revoked->requests_refused", "token.new_key->watcher_resumes")
def test_a_new_key_in_the_env_file_lets_the_restarted_watcher_claim_it_again(
    watcher: WatcherFactory,
    server: ServerView,
    admin: Admin,
    watcher_token: str,
) -> None:
    pc = watcher()
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "watching")
    admin.revoke_token(watcher_token).raise_for_status()
    assert pc.stop() == 0
    old_key = server.get(f"/api/v1/watchers/{pc.watcher_id}/upload-queue", token=watcher_token)
    assert old_key.status_code == 401, old_key

    # The operator puts a new key in the env file and starts the watcher again.
    replacement = admin.new_token()
    pc.write_env(api_key=replacement)
    before = server.last_heartbeat_id(pc.watcher_id)
    pc.start()

    # The first heartbeat that gets through is the new token's claim on the watcher.
    server.wait_for_heartbeats(pc.watcher_id, count=2, after_id=before)
    server.wait_for_watcher_status(pc.watcher_id, "watching")
    assert server.watcher(pc.watcher_id).registered_by_token == admin.token_id(replacement)
    assert server.effective_status(pc.watcher_id) == "watching"
    assert pc.is_running()


@pytest.mark.covers("watcher.registered->claimed_by_new_token")
def test_after_a_revocation_the_first_token_to_check_in_claims_the_watcher(
    watcher: WatcherFactory,
    server: ServerView,
    admin: Admin,
    watcher_token: str,
) -> None:
    pc = watcher()
    admin.revoke_token(watcher_token).raise_for_status()
    path = f"/api/v1/watchers/{pc.watcher_id}/upload-queue"

    first = admin.new_token()
    assert server.get(path, token=first).status_code == 200
    assert server.watcher(pc.watcher_id).registered_by_token == admin.token_id(first)

    # Once claimed, a later token is turned away, and the claimant keeps working.
    later = admin.new_token()
    assert server.get(path, token=later).status_code == 403
    assert server.get(path, token=first).status_code == 200
    row = server.watcher(pc.watcher_id)
    assert (row.status, row.registered_by_token) == ("registered", admin.token_id(first))


@pytest.mark.covers("token.other_token->forbidden")
def test_a_token_not_bound_to_the_watcher_gets_403_on_every_watcher_call(
    watcher: WatcherFactory,
    server: ServerView,
    admin: Admin,
    watcher_token: str,
) -> None:
    pc = watcher()
    other = admin.new_token()
    base = f"/api/v1/watchers/{pc.watcher_id}"

    # Some of the routes the watcher calls, each of which checks the binding.
    refused = {
        "GET upload-queue": server.get(f"{base}/upload-queue", token=other),
        "GET config-checksum": server.get(f"{base}/config-checksum", token=other),
        "GET config-revisions/latest": server.get(f"{base}/config-revisions/latest", token=other),
        "GET update-check": server.get(f"{base}/update-check", token=other),
        "POST heartbeat": _post(server, f"{base}/heartbeat", other, {"status": "watching"}),
        "POST events": _post(server, f"{base}/events", other, {"events": []}),
    }
    assert {name: r.status_code for name, r in refused.items()} == {name: 403 for name in refused}

    # The refused calls changed nothing, and the bound token still works.
    assert server.get(f"{base}/upload-queue", token=watcher_token).status_code == 200
    row = server.watcher(pc.watcher_id)
    assert (row.status, row.last_heartbeat_at) == ("registered", None)
    assert row.registered_by_token == admin.token_id(watcher_token)


# ---------------------------------------------------------------------------
# Deregistration and retirement
# ---------------------------------------------------------------------------


@pytest.mark.covers("watcher.registered->deregistered")
def test_an_admin_deregistration_makes_the_watcher_answer_404(
    watcher: WatcherFactory,
    server: ServerView,
    admin: Admin,
    watcher_token: str,
) -> None:
    pc = watcher()
    watcher_id = pc.watcher_id
    assert server.watcher_api(watcher_id) is not None

    deregistered = admin.deregister_watcher(watcher_id)
    deregistered.raise_for_status()
    assert deregistered.body["id"] == watcher_id

    assert server.watcher_api(watcher_id) is None
    assert server.watcher(watcher_id).deleted_at is not None
    base = f"/api/v1/watchers/{watcher_id}"
    assert server.get(base, token=watcher_token).status_code == 404
    assert (
        _post(server, f"{base}/heartbeat", watcher_token, {"status": "watching"}).status_code == 404
    )
    assert _post(server, f"{base}/events", watcher_token, {"events": []}).status_code == 404
    # Deregistering it again is a conflict, not a second teardown.
    assert admin.deregister_watcher(watcher_id).status_code == 409


@pytest.mark.covers("watcher.deregistered->queue_reverted")
def test_deregistering_the_watcher_reverts_its_queued_uploads(
    watcher: WatcherFactory,
    server: ServerView,
    admin: Admin,
    proxy: FaultProxy,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc, _ = _start_with_queued_upload(watcher, server, admin, proxy, instrument_id, watch_dir)
    old_id = pc.watcher_id

    admin.deregister_watcher(old_id).raise_for_status()

    reverted = server.wait_for_file(instrument_id, "RUN001", "RUN001/small.csv", status="detected")
    assert (reverted.upload_requested_at, reverted.uploaded_at) == (None, None)
    cancelled = server.wait_for_event(old_id, kind="upload_requests_cancelled")
    assert cancelled.details["reason"] == "watcher_deregistered"
    assert cancelled.details["cancelled_count"] == 1


@pytest.mark.covers("instrument.active->retired")
def test_retiring_the_instrument_deregisters_its_watcher_and_reverts_its_queue(
    watcher: WatcherFactory,
    server: ServerView,
    admin: Admin,
    proxy: FaultProxy,
    instrument_id: str,
    watch_dir: Path,
) -> None:
    pc, _ = _start_with_queued_upload(watcher, server, admin, proxy, instrument_id, watch_dir)
    watcher_id = pc.watcher_id

    admin.retire_instrument(instrument_id).raise_for_status()

    assert server.query("SELECT status::text FROM instruments WHERE id = %s", (instrument_id,)) == [
        ("inactive",)
    ]
    assert server.watcher(watcher_id).deleted_at is not None
    assert server.watcher_api(watcher_id) is None
    reverted = server.file(instrument_id, "RUN001", "RUN001/small.csv")
    assert reverted is not None and reverted.status == "detected"
    cancelled = server.wait_for_event(watcher_id, kind="upload_requests_cancelled")
    assert cancelled.details["reason"] == "instrument_retired"


@pytest.mark.covers("watcher.deregistered->reregistered_by_init")
def test_init_after_deregistration_registers_a_new_watcher_and_keeps_the_upload_history(
    watcher: WatcherFactory,
    server: ServerView,
    admin: Admin,
    proxy: FaultProxy,
    watch_dir: Path,
    instrument_id: str,
) -> None:
    pc = watcher()
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "watching")
    write_file(watch_dir / "RUN001" / "small.csv", SMALL)
    uploaded = server.wait_for_uploaded(instrument_id, "RUN001", "RUN001/small.csv")
    old_id = pc.watcher_id
    assert pc.stop() == 0
    admin.deregister_watcher(old_id).raise_for_status()

    # The same PC runs `init` again. Its saved key is used, and the config is overwritten.
    answers = _init_answers(pc, proxy, watch_dir, use_saved_key=True, overwrite_config=True)
    result = pc.init_interactive(answers)
    assert result.returncode == 0, result.output
    new_id = pc.watcher_id
    assert new_id != old_id
    assert server.watcher(new_id).status == "registered"
    assert server.watcher(old_id).deleted_at is not None

    # The new watcher's first scan finds the file the old one uploaded. The PC's state
    # database kept that, so the watcher never asks for an upload URL for it.
    requests_before = len(proxy.requests)
    pc.start()
    server.wait_for_watcher_status(new_id, "watching")
    stays_true(
        lambda: not [r for r in proxy.requests[requests_before:] if "request-upload-url" in r.path],
        4,
        lambda: server.dump(new_id, instrument_id),
        what="the new watcher to leave the uploaded file alone",
    )
    assert server.events(new_id, event_type="file_uploaded") == []
    rows = server.files(instrument_id, "RUN001", include_deleted=True)
    assert [(r.id, r.uploaded_at) for r in rows] == [(uploaded.id, uploaded.uploaded_at)]


# ---------------------------------------------------------------------------
# Known bug 08: a deregistered watcher keeps running with 404s
# ---------------------------------------------------------------------------


@pytest.mark.covers("watcher.deregistered->process_exits")
@pytest.mark.xfail(
    strict=True,
    raises=KnownBugStillPresent,
    reason=(
        "bug-08-deregistered-watcher-keeps-running: a running watcher that is deregistered "
        "keeps running with 404s instead of stopping with an error"
    ),
)
def test_a_running_watcher_exits_with_an_error_once_it_is_deregistered(
    watcher: WatcherFactory, server: ServerView, admin: Admin
) -> None:
    pc = watcher()
    pc.start()
    server.wait_for_watcher_status(pc.watcher_id, "watching")

    admin.deregister_watcher(pc.watcher_id).raise_for_status()

    with known_bug():
        wait_until(
            lambda: not pc.is_running(),
            REACTION_SECONDS,
            pc.log_tail,
            what="the deregistered watcher to exit",
        )
        assert pc.exit_code not in (None, 0), f"the watcher exited with {pc.exit_code}"
        assert re.search(r"(?i)deregister", pc.log_text()), "no log line says it was deregistered"


@pytest.mark.covers("startup.deregistered->refused")
@pytest.mark.xfail(
    strict=True,
    raises=KnownBugStillPresent,
    reason=(
        "bug-08-deregistered-watcher-keeps-running: starting a watcher whose registration was "
        "deleted runs it with 404s instead of refusing with a message to run init"
    ),
)
def test_starting_with_a_deregistered_watcher_refuses_and_says_to_run_init(
    watcher: WatcherFactory, admin: Admin
) -> None:
    pc = watcher()
    admin.deregister_watcher(pc.watcher_id).raise_for_status()

    pc.start(wait_ready=False)

    with known_bug():
        wait_until(
            lambda: not pc.is_running(),
            REACTION_SECONDS,
            pc.log_tail,
            what="the watcher to refuse to start",
        )
        assert pc.exit_code not in (None, 0), f"the watcher exited with {pc.exit_code}"
        assert re.search(r"\binit\b", pc.log_text()), "the refusal does not say to run init"
