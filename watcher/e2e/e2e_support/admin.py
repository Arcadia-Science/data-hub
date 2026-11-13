"""The actions an operator takes in the web app, through the real REST routes.

``Admin`` is the "other side" of a scenario: while the watcher runs on its PC, an admin
queues an upload, deletes a run, changes the watcher's config, retires the instrument or
revokes the PC's token. Each method calls the same route the web app (or a script, or the
MCP server) calls, with the credential that route needs:

* The ``*`` token the harness seeds: request-upload, run delete and restore, file dismiss,
  instrument status, watcher deregistration.
* A token that lists ``watchers:read`` and ``watchers:admin`` explicitly: config revisions.
  ``*`` and the legacy coarse scopes are refused there on purpose.
* The signed session cookie of a seeded admin (``seed_admin_session``): the watcher
  release settings (``PUT /api/v1/settings/watcher-release``) and revoking a token.
* The cron secret: ``/api/cron/upload-queue-sweep``.

Every method returns an :class:`~e2e_support._http.ApiResult` and raises nothing for a 4xx,
so a scenario can assert on a refusal (``result.status_code == 409``,
``result.error_code == "WATCHER_OFFLINE"``). On the happy path call
``.raise_for_status()``.
"""

from __future__ import annotations
import hashlib
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, Literal, cast
from urllib.parse import quote

from data_hub_shared.testing import AdminSession, IntegrationEnv, db_query, seed_auth
from e2e_support._http import ApiResult, call, new_session

__all__ = [
    "ADMIN_REVISION_SCOPES",
    "WATCHER_SCOPES",
    "Admin",
    "revision_settings",
]

# The "watcher" preset in web/lib/api/scope-catalog.ts: what a token on an instrument PC has.
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

# Config revisions need these two listed explicitly (see `requireExplicitTokenScope`).
ADMIN_REVISION_SCOPES = ["watchers:read", "watchers:admin"]


def _run_path(instrument_id: str, run_id: str) -> str:
    """The API path of a run. A run ID can hold ``#``, ``?`` or ``%``, so each part is
    percent-encoded into one path segment, as the web app does."""
    return f"/api/v1/instruments/{quote(instrument_id, safe='')}/runs/{quote(run_id, safe='')}"


def revision_settings(
    watch_directory: str | Path,
    *,
    file_patterns: Sequence[str] = ("*.csv",),
    run_pattern: str = r"^([^/]+)/",
    recursive: bool = True,
    upload_mode: Literal["auto", "manual"] = "auto",
    stability_period_seconds: int = 1,
    max_stability_wait_seconds: int = 60,
    upload_parallelism: int = 4,
) -> dict[str, Any]:
    """The ``settings`` object of a config revision, with the e2e suite's defaults.

    These are the eight settings an admin can change. Pass the values of the running config
    that should stay the same: a revision with every setting equal to the running ones needs
    no rebuild, which is a transition of its own.
    """
    return {
        "watch_directory": str(watch_directory),
        "file_patterns": list(file_patterns),
        "run_detection": {"pattern": run_pattern, "recursive": recursive},
        "upload_mode": upload_mode,
        "stability_period_seconds": stability_period_seconds,
        "max_stability_wait_seconds": max_stability_wait_seconds,
        "upload_parallelism": upload_parallelism,
    }


class Admin:
    """Admin actions against the test server. See the module docstring for the credentials.

    ``revision_token`` is a token that lists ``watchers:read`` and ``watchers:admin``. The
    session fixture makes one, and :meth:`new_token` makes more.
    """

    def __init__(self, env: IntegrationEnv, *, session: AdminSession, revision_token: str) -> None:
        self.env = env
        self.session = session
        self.revision_token = revision_token
        self._http = new_session()

    # ------------------------------------------------------------------
    # Plumbing
    # ------------------------------------------------------------------

    def _bearer(self, token: str | None = None) -> dict[str, str]:
        return {"Authorization": f"Bearer {token or self.env.api_token}"}

    def _cookie(self) -> dict[str, str]:
        return {"Cookie": self.session.cookie_header}

    def _call(
        self, method: str, path: str, *, headers: dict[str, str], json: Any = None
    ) -> ApiResult:
        return call(self._http, method, f"{self.env.base_url}{path}", headers=headers, json=json)

    # ------------------------------------------------------------------
    # Runs and files (the `*` token)
    # ------------------------------------------------------------------

    def request_upload(self, instrument_id: str, run_id: str, file_ids: Sequence[int]) -> ApiResult:
        """Queue files for upload, like "Request upload" on a run page.

        The server refuses (409 ``WATCHER_OFFLINE``) when the instrument has no watcher
        whose last heartbeat is under five minutes old.
        """
        return self._call(
            "POST",
            f"{_run_path(instrument_id, run_id)}/request-upload",
            headers=self._bearer(),
            json={"file_ids": list(file_ids)},
        )

    def request_upload_all(self, instrument_id: str, run_id: str) -> ApiResult:
        """Queue every ``detected`` file of the run for upload."""
        return self._call(
            "POST",
            f"{_run_path(instrument_id, run_id)}/request-upload-all",
            headers=self._bearer(),
        )

    def delete_run(self, instrument_id: str, run_id: str) -> ApiResult:
        """Soft-delete a run. Its files stay, and the watcher's updates to it get a 409."""
        return self._call(
            "DELETE",
            _run_path(instrument_id, run_id),
            headers=self._bearer(),
        )

    def restore_run(self, instrument_id: str, run_id: str) -> ApiResult:
        """Undo :meth:`delete_run`."""
        return self._call(
            "POST",
            f"{_run_path(instrument_id, run_id)}/restore",
            headers=self._bearer(),
        )

    def dismiss_file(self, file_id: int) -> ApiResult:
        """Dismiss a file that has not been uploaded: it is soft-deleted and leaves the queue."""
        return self._call("DELETE", f"/api/v1/files/{file_id}", headers=self._bearer())

    # ------------------------------------------------------------------
    # Instruments and watchers (the `*` token)
    # ------------------------------------------------------------------

    def set_instrument_status(
        self, instrument_id: str, status: Literal["pending", "active", "inactive"]
    ) -> ApiResult:
        """``PATCH`` the instrument's status. ``inactive`` retires it, which also deregisters
        its watchers and reverts their upload queue."""
        return self._call(
            "PATCH",
            f"/api/v1/instruments/{instrument_id}",
            headers=self._bearer(),
            json={"status": status},
        )

    def activate_instrument(self, instrument_id: str) -> ApiResult:
        """Confirm a pending instrument, so a watcher may start for it."""
        return self.set_instrument_status(instrument_id, "active")

    def retire_instrument(self, instrument_id: str) -> ApiResult:
        """Retire the instrument: its status becomes ``inactive`` and its watchers are
        deregistered, with their queued uploads reverted to ``detected``."""
        return self.set_instrument_status(instrument_id, "inactive")

    def deregister_watcher(self, watcher_id: str) -> ApiResult:
        """Deregister a watcher (soft-delete it), like the Deregister button."""
        return self._call("DELETE", f"/api/v1/watchers/{watcher_id}", headers=self._bearer())

    # ------------------------------------------------------------------
    # Config revisions (a token that lists watchers:admin)
    # ------------------------------------------------------------------

    def config_revisions(self, watcher_id: str) -> list[dict[str, Any]]:
        """The watcher's config history, newest first."""
        result = self._call(
            "GET",
            f"/api/v1/watchers/{watcher_id}/config-revisions",
            headers=self._bearer(self.revision_token),
        ).raise_for_status()
        return list(cast("dict[str, Any]", result.body)["data"])

    def config_revision(self, watcher_id: str, number: int) -> dict[str, Any]:
        """One revision from :meth:`config_revisions`, by number."""
        [match] = [r for r in self.config_revisions(watcher_id) if r["revision"] == number]
        return match

    def save_config_revision(
        self,
        watcher_id: str,
        settings: Mapping[str, Any],
        *,
        base_revision: int | None | Literal["latest"] = "latest",
    ) -> ApiResult:
        """Save ``settings`` (see :func:`revision_settings`) as a new pending revision.

        ``base_revision`` is the revision the admin was looking at. The default, ``"latest"``,
        is the current highest one, so the save does not count as a conflict.
        """
        if base_revision == "latest":
            history = self.config_revisions(watcher_id)
            base_revision = history[0]["revision"] if history else None
        return self._call(
            "POST",
            f"/api/v1/watchers/{watcher_id}/config-revisions",
            headers=self._bearer(self.revision_token),
            json={"base_revision": base_revision, "settings": dict(settings)},
        )

    # ------------------------------------------------------------------
    # Watcher releases and tokens (the admin session cookie)
    # ------------------------------------------------------------------

    def set_release(
        self,
        latest_version: str | None,
        *,
        min_supported_version: str | None = None,
        mandatory: bool = False,
    ) -> ApiResult:
        """``PUT /api/v1/settings/watcher-release``: what the update check offers the watcher.

        ``min_supported_version`` above a watcher's version makes its heartbeats fail with a
        426. ``mandatory`` makes the watcher install ``latest_version`` without waiting for
        the instrument to be idle. The session fixture sets the latest version to the current
        one, so no scenario is offered an update unless it asks for one.
        """
        return self._call(
            "PUT",
            "/api/v1/settings/watcher-release",
            headers=self._cookie(),
            json={
                "latest_version": latest_version,
                "min_supported_version": min_supported_version,
                "mandatory": mandatory,
            },
        )

    def get_release(self) -> dict[str, Any]:
        """The current release settings."""
        result = self._call(
            "GET", "/api/v1/settings/watcher-release", headers=self._cookie()
        ).raise_for_status()
        return cast("dict[str, Any]", result.body)

    def token_id(self, plaintext_token: str) -> str:
        """The id of a personal access token, from its plaintext value."""
        digest = hashlib.sha256(plaintext_token.encode()).hexdigest()
        rows = db_query(
            self.env.db_dsn,
            "SELECT id::text FROM personal_access_tokens WHERE token_hash = %s",
            (digest,),
        )
        if not rows:
            raise LookupError("No such token")
        return cast("str", rows[0][0])

    def revoke_token(self, plaintext_token: str) -> ApiResult:
        """Revoke a token (an admin does this in Settings). Every watcher request with it then
        gets a 401, and the watchers bound to it can be claimed by another token.

        Never pass ``env.api_token``: the rest of the session uses it.
        """
        if plaintext_token == self.env.api_token:
            raise ValueError("Refusing to revoke the session's own `*` token")
        return self._call(
            "DELETE",
            f"/api/v1/tokens/{self.token_id(plaintext_token)}",
            headers=self._cookie(),
        )

    def new_token(self, scopes: Sequence[str] | None = None) -> str:
        """Mint a personal access token and return its plaintext.

        With no ``scopes`` it has the watcher preset (:data:`WATCHER_SCOPES`), like a token
        on an instrument PC.
        """
        return seed_auth(self.env.db_dsn, scopes=list(scopes or WATCHER_SCOPES))

    # ------------------------------------------------------------------
    # Cron (the cron secret)
    # ------------------------------------------------------------------

    def sweep(self) -> ApiResult:
        """Run the upload-queue sweep, as Vercel Cron would.

        It reverts a queued file to ``detected`` once the instrument's newest watcher
        heartbeat is more than 15 minutes old (age it with ``ServerView.age_past_sweep_grace``).
        The body is ``{"swept_instruments", "reverted_files", "failed_instruments"}``.
        """
        return self._call(
            "GET",
            "/api/cron/upload-queue-sweep",
            headers={"Authorization": f"Bearer {self.env.cron_secret}"},
        )
