"""Integration tests: config revisions from the web app, end to end.

A real `WatcherSupervisor` (real runtime, state DB, monitor and heartbeat)
runs against the real Next.js server. The watcher uses a token with the
watcher preset's scopes, and the admin side goes through the public
`POST /watchers/{id}/config-revisions` route with a token that has
`watchers:admin`, the way a script or the MCP tool would.

Heartbeats are sent by calling the loop's `_send_heartbeat` instead of
waiting 60 seconds for the next tick, then `poll` handles the reply on the
test thread, as the CLI's and the service's main loops do.
"""

from __future__ import annotations
import os
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
import requests
import yaml

from data_hub_shared.testing import IntegrationEnv, db_query, seed_auth
from data_hub_watcher.api_client import DataHubClient
from data_hub_watcher.config_io import save_config
from data_hub_watcher.models import InstrumentConfig, RunDetectionConfig, WatcherConfig
from data_hub_watcher.runtime import WatcherSupervisor

pytestmark = pytest.mark.integration

# The "watcher" preset in web/lib/api/scope-catalog.ts.
WATCHER_SCOPES = [
    "instruments:read",
    "instruments:write",
    "watchers:read",
    "watchers:report",
    "runs:create",
    "runs:update",
    "runs:upload",
    "files:update",
]


class _Admin:
    """The admin side, through the public REST routes."""

    def __init__(self, base_url: str, token: str) -> None:
        self._base = f"{base_url}/api/v1"
        self._session = requests.Session()
        self._session.headers["Authorization"] = f"Bearer {token}"

    def revisions(self, watcher_id: str) -> list[dict[str, Any]]:
        resp = self._session.get(f"{self._base}/watchers/{watcher_id}/config-revisions", timeout=30)
        resp.raise_for_status()
        return list(resp.json()["data"])

    def save(self, watcher_id: str, settings: dict[str, Any]) -> dict[str, Any]:
        """Save *settings* as a new revision, based on the latest one."""
        history = self.revisions(watcher_id)
        base = history[0]["revision"] if history else None
        resp = self._session.post(
            f"{self._base}/watchers/{watcher_id}/config-revisions",
            json={"base_revision": base, "settings": settings},
            timeout=30,
        )
        assert resp.status_code == 201, resp.text
        return dict(resp.json())

    def revision(self, watcher_id: str, number: int) -> dict[str, Any]:
        [match] = [r for r in self.revisions(watcher_id) if r["revision"] == number]
        return match


class _Pc:
    """An instrument PC: a watch folder, `config.yaml` and the state DB."""

    def __init__(self, tmp_path: Path, client: DataHubClient, base_url: str, watcher_id: str):
        self.tmp_path = tmp_path
        self.client = client
        self.base_url = base_url
        self.watcher_id = watcher_id
        self.watch_dir = (tmp_path / "data").resolve()
        self.watch_dir.mkdir()
        (self.watch_dir / "RUN001_sample.csv").write_text("a,b\n1,2\n")
        self.config_path = tmp_path / "config.yaml"
        self.db_path = tmp_path / "state" / "watcher.staging.db"
        self.supervisors: list[WatcherSupervisor] = []

    def write_config(self, *, watch_dir: Path | None = None, patterns: list[str] | None = None):
        cfg = WatcherConfig(
            version=1,
            environment="staging",
            api_base_urls={"staging": f"{self.base_url}/api/v1"},
            watcher_ids={"staging": self.watcher_id},
            # Staging defaults to `new-only`: files already on disk at the
            # first start are recorded as baseline, never uploaded.
            instrument=InstrumentConfig(
                id=INSTRUMENT_ID,
                watch_directory=watch_dir or self.watch_dir,
                file_patterns=patterns or ["*.csv"],
                upload_mode="auto",
                stability_period_seconds=1,
                max_stability_wait_seconds=60,
                run_detection=RunDetectionConfig(pattern=r"^([^_]+)", recursive=False),
            ),
        )
        save_config(cfg, self.config_path)
        return cfg

    def settings(self, **overrides: Any) -> dict[str, Any]:
        settings: dict[str, Any] = {
            "watch_directory": str(self.watch_dir),
            "file_patterns": ["*.csv"],
            "run_detection": {"pattern": r"^([^_]+)", "recursive": False},
            "upload_mode": "auto",
            "stability_period_seconds": 1,
            "max_stability_wait_seconds": 60,
            "upload_parallelism": 4,
        }
        settings.update(overrides)
        return settings

    def start(self) -> WatcherSupervisor:
        from data_hub_watcher.config_io import load_config

        sup = WatcherSupervisor(
            client=self.client,
            cfg=load_config(self.config_path),
            config_path=self.config_path,
            db_path=self.db_path,
            config_dir=self.tmp_path,
            role="Watcher",
            host="integration-test",
        )
        self.supervisors.append(sup)
        sup.start()
        return sup

    def saved_instrument(self) -> dict[str, Any]:
        return dict(yaml.safe_load(self.config_path.read_text(encoding="utf-8"))["instrument"])


INSTRUMENT_ID = "watcher-contract-test"


def _heartbeat(sup: WatcherSupervisor) -> None:
    """Send one heartbeat and handle its reply, like one tick of the main loop."""
    if sup.rt is not None:
        loop = sup.rt.heartbeat
    else:
        assert sup._waiting is not None
        loop = sup._waiting.heartbeat
    loop._send_heartbeat(status=loop._status)
    sup.poll(timeout=0)


def _watcher_row(dsn: str, watcher_id: str) -> tuple[Any, ...]:
    [row] = db_query(
        dsn,
        """SELECT status, status_reason, config_revision, applied_config_revision,
                  watcher_version
           FROM watchers WHERE id = %s""",
        (watcher_id,),
    )
    return row


@pytest.fixture(scope="module")
def watcher_client(integration_env: IntegrationEnv) -> DataHubClient:
    token = seed_auth(integration_env.db_dsn, scopes=WATCHER_SCOPES)
    return DataHubClient(base_url=f"{integration_env.base_url}/api/v1", api_key=token)


@pytest.fixture(scope="module")
def admin(integration_env: IntegrationEnv) -> _Admin:
    token = seed_auth(integration_env.db_dsn, scopes=["watchers:read", "watchers:admin"])
    return _Admin(integration_env.base_url, token)


@pytest.fixture
def pc(
    tmp_path: Path, watcher_client: DataHubClient, integration_env: IntegrationEnv
) -> Iterator[_Pc]:
    watcher = watcher_client.register_watcher(INSTRUMENT_ID)
    machine = _Pc(tmp_path, watcher_client, integration_env.base_url, watcher.watcher_id)
    machine.write_config()
    try:
        yield machine
    finally:
        for sup in machine.supervisors:
            if sup.rt is not None or sup.waiting_reason is not None:
                sup.stop(stopped_message="test teardown")


class TestAdminRevision:
    def test_is_fetched_applied_and_reported_through_the_heartbeat(
        self, pc: _Pc, admin: _Admin, integration_env: IntegrationEnv
    ) -> None:
        sup = pc.start()
        # The startup push recorded the PC's config as revision 1.
        [first] = admin.revisions(pc.watcher_id)
        assert (first["revision"], first["source"], first["status"]) == (1, "pc", "applied")
        assert sup.applied_revision == 1
        assert _watcher_row(integration_env.db_dsn, pc.watcher_id)[4] == "1.4.0"

        # A .txt file that was already on disk before the change.
        old_txt = pc.watch_dir / "RUN002_notes.txt"
        old_txt.write_text("old notes\n")
        past = time.time() - 3600
        os.utime(old_txt, (past, past))

        created = admin.save(pc.watcher_id, pc.settings(file_patterns=["*.csv", "*.txt"]))
        assert (created["revision"], created["status"]) == (2, "pending")

        _heartbeat(sup)

        applied = admin.revision(pc.watcher_id, 2)
        assert applied["status"] == "applied"
        assert sup.applied_revision == 2
        assert pc.saved_instrument()["file_patterns"] == ["*.csv", "*.txt"]
        assert sup.rt is not None and sup.rt.monitor._patterns == ["*.csv", "*.txt"]
        # The push after applying matched the revision, so no PC revision.
        assert [r["revision"] for r in admin.revisions(pc.watcher_id)] == [2, 1]
        events = db_query(
            integration_env.db_dsn,
            "SELECT details->>'kind' FROM watcher_events WHERE watcher_id = %s "
            "AND event_type = 'config_synced'",
            (pc.watcher_id,),
        )
        assert ("config_revision_applied",) in events

        # The next heartbeat reports revision 2 as applied.
        _heartbeat(sup)
        row = _watcher_row(integration_env.db_dsn, pc.watcher_id)
        assert (row[0], row[2], row[3]) == ("watching", 2, 2)

        # The old .txt file was reported as detected, not uploaded.
        deadline = time.monotonic() + 15
        rows: list[tuple[Any, ...]] = []
        while time.monotonic() < deadline:
            rows = db_query(
                integration_env.db_dsn,
                "SELECT relative_path, status FROM files WHERE filename = %s",
                ("RUN002_notes.txt",),
            )
            if rows:
                break
            time.sleep(0.25)
        assert rows == [("RUN002_notes.txt", "detected")]

    def test_folder_that_resolves_elsewhere_leaves_no_pc_revision(
        self, pc: _Pc, admin: _Admin
    ) -> None:
        sup = pc.start()
        # The admin types a path that resolves to another one, like a mapped
        # drive that resolves to a UNC path on Windows. The server normalizes
        # slashes, case and trailing separators, but can't see through this,
        # so the watcher must push the folder back as typed.
        link = pc.tmp_path / "data-link"
        link.symlink_to(pc.watch_dir, target_is_directory=True)
        admin.save(pc.watcher_id, pc.settings(watch_directory=str(link), upload_parallelism=2))

        _heartbeat(sup)
        _heartbeat(sup)

        history = admin.revisions(pc.watcher_id)
        assert [(r["revision"], r["source"], r["status"]) for r in history] == [
            (2, "web", "applied"),
            (1, "pc", "applied"),
        ]
        assert sup.applied_revision == 2
        assert sup.rt is not None and sup.rt.uploader._parallelism == 2
        assert sup.rt.monitor._watch_dir == pc.watch_dir
        assert pc.saved_instrument()["watch_directory"] == str(link)


class TestRejectedRevision:
    def test_missing_folder_is_rejected_with_the_reason(
        self, pc: _Pc, admin: _Admin, integration_env: IntegrationEnv
    ) -> None:
        sup = pc.start()
        before = pc.config_path.read_bytes()
        missing = pc.tmp_path / "not-there"
        admin.save(pc.watcher_id, pc.settings(watch_directory=str(missing)))

        _heartbeat(sup)

        rejected = admin.revision(pc.watcher_id, 2)
        assert rejected["status"] == "rejected"
        assert "watch_directory not found" in rejected["status_reason"]
        assert str(missing) in rejected["status_reason"]
        assert pc.config_path.read_bytes() == before
        assert sup.rt is not None and sup.cfg.instrument.watch_directory == pc.watch_dir
        assert sup.seen_revision == 2 and sup.applied_revision == 1
        [(kind, reason)] = db_query(
            integration_env.db_dsn,
            "SELECT details->>'kind', details->>'reason' FROM watcher_events "
            "WHERE watcher_id = %s AND event_type = 'error' "
            "AND details->>'kind' = 'config_revision_rejected'",
            (pc.watcher_id,),
        )
        assert kind == "config_revision_rejected"
        assert isinstance(reason, str) and "watch_directory not found" in reason

        # Later heartbeats don't fetch or report it again.
        _heartbeat(sup)
        assert admin.revision(pc.watcher_id, 2)["status"] == "rejected"
        row = _watcher_row(integration_env.db_dsn, pc.watcher_id)
        assert (row[2], row[3]) == (2, 1)


class TestPcRevision:
    def test_edit_on_the_pc_is_recorded_as_a_pc_revision(
        self, pc: _Pc, admin: _Admin, integration_env: IntegrationEnv
    ) -> None:
        first = pc.start()
        first.stop(stopped_message="stopped for an edit")
        # Edited on the PC while the watcher was stopped.
        pc.write_config(patterns=["*.csv", "*.xlsx"])

        sup = pc.start()

        history = admin.revisions(pc.watcher_id)
        assert [(r["revision"], r["source"], r["status"]) for r in history] == [
            (2, "pc", "applied"),
            (1, "pc", "applied"),
        ]
        assert history[0]["settings"]["file_patterns"] == ["*.csv", "*.xlsx"]
        assert history[0]["created_by"] is None
        assert history[0]["created_by_token"] is not None
        assert sup.applied_revision == 2
        _heartbeat(sup)
        row = _watcher_row(integration_env.db_dsn, pc.watcher_id)
        assert (row[2], row[3]) == (2, 2)


class TestStartup:
    def test_pending_revision_is_applied_before_watching(
        self, pc: _Pc, admin: _Admin, integration_env: IntegrationEnv
    ) -> None:
        first = pc.start()
        first.stop(stopped_message="stopped")
        # Saved in the web app while the watcher was stopped.
        admin.save(pc.watcher_id, pc.settings(file_patterns=["*.csv", "*.json"]))

        sup = pc.start()

        assert admin.revision(pc.watcher_id, 2)["status"] == "applied"
        assert sup.applied_revision == 2
        # The first runtime of this process already runs the new config.
        assert sup.rt is not None and sup.rt.monitor._patterns == ["*.csv", "*.json"]
        assert pc.saved_instrument()["file_patterns"] == ["*.csv", "*.json"]
        assert [r["revision"] for r in admin.revisions(pc.watcher_id)] == [2, 1]

    def test_offline_conflict_won_by_the_web_change(
        self, pc: _Pc, admin: _Admin, integration_env: IntegrationEnv
    ) -> None:
        first = pc.start()
        first.stop(stopped_message="stopped")
        # The PC's file was edited an hour ago, then an admin saved a change.
        pc.write_config(patterns=["*.csv", "*.dat"])
        an_hour_ago = time.time() - 3600
        os.utime(pc.config_path, (an_hour_ago, an_hour_ago))
        admin.save(pc.watcher_id, pc.settings(file_patterns=["*.csv", "*.txt"]))

        sup = pc.start()

        # The newer web change won; the PC's edit is kept as superseded
        # history above it.
        history = admin.revisions(pc.watcher_id)
        assert [(r["revision"], r["source"], r["status"]) for r in history] == [
            (3, "pc", "superseded"),
            (2, "web", "applied"),
            (1, "pc", "applied"),
        ]
        assert sup.cfg.instrument.file_patterns == ["*.csv", "*.txt"]
        assert pc.saved_instrument()["file_patterns"] == ["*.csv", "*.txt"]
        assert sup.applied_revision == 2

        # Heartbeats announce 3, the superseded revision. The watcher looks
        # once, records it as seen, and never applies or reports it.
        _heartbeat(sup)
        assert sup.seen_revision == 3 and sup.applied_revision == 2
        _heartbeat(sup)
        history = admin.revisions(pc.watcher_id)
        assert [(r["revision"], r["status"]) for r in history] == [
            (3, "superseded"),
            (2, "applied"),
            (1, "applied"),
        ]
        assert sup.cfg.instrument.file_patterns == ["*.csv", "*.txt"]
        row = _watcher_row(integration_env.db_dsn, pc.watcher_id)
        assert (row[2], row[3]) == (3, 2)


class TestWaitingState:
    def test_waiting_watcher_is_fixed_from_the_web(
        self, pc: _Pc, admin: _Admin, integration_env: IntegrationEnv
    ) -> None:
        missing = pc.tmp_path / "unplugged"
        pc.write_config(watch_dir=missing)

        sup = pc.start()

        assert sup.rt is None and sup.waiting_reason is not None
        status, reason, *_ = _watcher_row(integration_env.db_dsn, pc.watcher_id)
        assert status == "waiting"
        assert "watch_directory not found" in reason

        admin.save(pc.watcher_id, pc.settings())
        _heartbeat(sup)

        assert sup.waiting_reason is None and sup.rt is not None
        assert admin.revision(pc.watcher_id, 2)["status"] == "applied"
        _heartbeat(sup)
        status, reason, _, applied, _ = _watcher_row(integration_env.db_dsn, pc.watcher_id)
        assert (status, reason, applied) == ("watching", None, 2)
