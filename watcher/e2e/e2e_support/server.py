"""What the server says about a watcher, its runs and its files.

``ServerView`` reads the test database directly, and the REST API where the answer is
computed by the server (the effective watcher status, which adds ``stale``). Tests assert
on it and never on the watcher's own logs, because the server's view is the product: it is
what the web app shows.

The ageing helpers move a timestamp into the past, to cross a server timer (the 5-minute
stale mark, the 15-minute sweep grace) without waiting for it. A running watcher
overwrites ``last_heartbeat_at`` with every heartbeat, so a test that ages it must first
stop the watcher, or keep its heartbeats from arriving with a proxy fault on
``/heartbeat``.

The S3 stand-in is a folder: ``object_path`` and ``read_object`` read it.
"""

from __future__ import annotations
import json
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Literal, cast

from data_hub_shared.testing import IntegrationEnv, db_query, db_update
from e2e_support._http import ApiResult, call, new_session
from e2e_support.waiting import wait_until

__all__ = [
    "STALE_AFTER_MINUTES",
    "SWEEP_GRACE_MINUTES",
    "EventRow",
    "FileRow",
    "HeartbeatRow",
    "RunRow",
    "ServerView",
    "WatcherRow",
]

# The server's own timers, from `STALE_THRESHOLD_MS` and `UPLOAD_REQUEST_REVERT_GRACE_MS` in
# web/lib/api/watchers.ts.
STALE_AFTER_MINUTES = 5
SWEEP_GRACE_MINUTES = 15

RunStatus = Literal["failed", "pending", "uploaded", "processing", "completed", "empty"]


@dataclass(frozen=True)
class WatcherRow:
    """One row of the ``watchers`` table.

    ``status`` is the stored status (``registered``, ``watching``, ``stopped`` or
    ``waiting``). ``stale`` is never stored: ask :meth:`ServerView.effective_status`.
    """

    id: str
    instrument_id: str
    status: str
    status_reason: str | None
    config_revision: int | None
    applied_config_revision: int | None
    watcher_version: str | None
    last_heartbeat_at: datetime | None
    deleted_at: datetime | None
    registered_by_token: str | None
    config_checksum: str | None
    config_yaml: str | None
    hostname: str | None


@dataclass(frozen=True)
class EventRow:
    """One row of ``watcher_events``.

    ``timestamp`` is when the watcher says the event happened, and ``created_at`` is when
    the server stored it, which is the order events and heartbeats arrived in.
    """

    id: int
    event_type: str
    message: str
    details: dict[str, Any]
    timestamp: datetime
    created_at: datetime

    @property
    def kind(self) -> str | None:
        """``details.kind``, the discriminator of ``error`` events (and a few others)."""
        value = self.details.get("kind")
        return value if isinstance(value, str) else None


@dataclass(frozen=True)
class HeartbeatRow:
    """One row of ``watcher_heartbeats``, as the watcher sent it."""

    id: int
    status: str
    timestamp: datetime
    created_at: datetime
    upload_mode: str | None
    files_uploaded_since_last: int | None
    runs_reported_since_last: int | None
    errors_since_last: int | None
    uptime_seconds: int | None


@dataclass(frozen=True)
class RunRow:
    """One row of ``instrument_runs``. ``run_id`` is the run's name; ``id`` is the row's UUID."""

    id: str
    instrument_id: str
    run_id: str
    source: str
    watcher_id: str | None
    deleted_at: datetime | None
    acquired_at: datetime | None


@dataclass(frozen=True)
class FileRow:
    """One row of ``files``, with its run's name and whether the run is deleted.

    ``status`` is ``detected``, ``upload_requested``, ``uploaded``, ... ``s3_key`` is set
    once the file is uploaded, as ``<instrument>/<run>/<filename>``.
    """

    id: int
    instrument_id: str
    run_id: str
    relative_path: str | None
    filename: str
    status: str
    size_bytes: int | None
    s3_bucket: str | None
    s3_key: str | None
    upload_requested_at: datetime | None
    uploaded_at: datetime | None
    deleted_at: datetime | None
    run_deleted_at: datetime | None
    error_message: str | None


_WATCHER_COLUMNS = """id::text, instrument_id, status::text, status_reason, config_revision,
    applied_config_revision, watcher_version, last_heartbeat_at, deleted_at,
    registered_by_token::text, config_checksum, config_yaml, hostname"""

_FILE_SELECT = """SELECT f.id, r.instrument_id, r.run_id, f.relative_path, f.filename,
        f.status::text, f.size_bytes, f.s3_bucket, f.s3_key, f.upload_requested_at,
        f.uploaded_at, f.deleted_at, r.deleted_at, f.error_message
    FROM files f JOIN instrument_runs r ON r.id = f.instrument_run_id"""


def _file_row(row: tuple[object, ...]) -> FileRow:
    return FileRow(*cast("tuple[Any, ...]", row))


@dataclass
class ServerView:
    """Reads the server's state for one test.

    ``env`` is the session's ``IntegrationEnv``. ``watcher_token`` is the personal access
    token the watcher under test uses. Only :meth:`upload_queue` needs it, because that
    route is bound to the token that registered the watcher, and reading it with another
    token would claim the watcher for that token.
    """

    env: IntegrationEnv
    watcher_token: str | None = None
    _session: Any = field(default_factory=new_session, repr=False)

    # ------------------------------------------------------------------
    # Raw access
    # ------------------------------------------------------------------

    def query(self, sql: str, params: tuple[object, ...] | None = None) -> list[tuple[object, ...]]:
        """Run a SELECT against the test database."""
        return db_query(self.env.db_dsn, sql, params)

    def execute(self, sql: str, params: tuple[object, ...] | None = None) -> None:
        """Run an UPDATE or INSERT, to set up or simulate a server-side change."""
        db_update(self.env.db_dsn, sql, params)

    def get(self, path: str, *, token: str | None = None) -> ApiResult:
        """``GET`` a REST path such as ``/api/v1/watchers/<id>``, as ``token`` or the ``*`` one."""
        return call(
            self._session,
            "GET",
            f"{self.env.base_url}{path}",
            headers={"Authorization": f"Bearer {token or self.env.api_token}"},
        )

    # ------------------------------------------------------------------
    # Watcher
    # ------------------------------------------------------------------

    def watcher(self, watcher_id: str) -> WatcherRow:
        """The watcher's row, including a deregistered watcher (``deleted_at`` is set)."""
        rows = self.query(f"SELECT {_WATCHER_COLUMNS} FROM watchers WHERE id = %s", (watcher_id,))
        if not rows:
            raise LookupError(f"No watcher {watcher_id}")
        return WatcherRow(*cast("tuple[Any, ...]", rows[0]))

    def watcher_api(self, watcher_id: str) -> dict[str, Any] | None:
        """``GET /api/v1/watchers/:id``, or ``None`` for a deregistered or unknown watcher."""
        result = self.get(f"/api/v1/watchers/{watcher_id}")
        if result.status_code == 404:
            return None
        result.raise_for_status()
        return cast("dict[str, Any]", result.body)

    def effective_status(self, watcher_id: str) -> str | None:
        """The status the web app shows: the stored one, or ``stale`` once the last heartbeat
        is more than five minutes old. ``registered`` is exempt. ``None`` if deregistered."""
        body = self.watcher_api(watcher_id)
        return None if body is None else str(body["status"])

    def upload_queue(self, watcher_id: str) -> list[dict[str, Any]]:
        """The watcher's upload queue as the route answers it, which is what the watcher polls."""
        if self.watcher_token is None:
            raise RuntimeError("ServerView.upload_queue needs the watcher's token (watcher_token=)")
        result = self.get(f"/api/v1/watchers/{watcher_id}/upload-queue", token=self.watcher_token)
        result.raise_for_status()
        return list(cast("dict[str, Any]", result.body)["files"])

    # ------------------------------------------------------------------
    # Events and heartbeats
    # ------------------------------------------------------------------

    def events(
        self,
        watcher_id: str,
        *,
        event_type: str | None = None,
        kind: str | None = None,
        message_contains: str | None = None,
        after_id: int = 0,
    ) -> list[EventRow]:
        """The watcher's events, oldest first by the watcher's own timestamp.

        ``kind`` matches ``details.kind``. ``after_id`` keeps only events stored after a row
        a test saw earlier (``max(e.id for e in events)``), to look at what is new.
        """
        sql = (
            "SELECT id, event_type::text, message, details, timestamp, created_at "
            "FROM watcher_events WHERE watcher_id = %s AND id > %s"
        )
        params: list[object] = [watcher_id, after_id]
        if event_type is not None:
            sql += " AND event_type = %s"
            params.append(event_type)
        if kind is not None:
            sql += " AND details->>'kind' = %s"
            params.append(kind)
        if message_contains is not None:
            sql += " AND position(%s in message) > 0"
            params.append(message_contains)
        sql += " ORDER BY timestamp, id"
        rows = self.query(sql, tuple(params))
        return [
            EventRow(
                id=cast("int", r[0]),
                event_type=cast("str", r[1]),
                message=cast("str", r[2]),
                details=cast("dict[str, Any]", r[3]) if isinstance(r[3], dict) else {},
                timestamp=cast("datetime", r[4]),
                created_at=cast("datetime", r[5]),
            )
            for r in rows
        ]

    def event_summary(self, watcher_id: str) -> list[str]:
        """``type`` or ``type:kind`` of each event, oldest first, for compact assertions."""
        return [
            e.event_type if e.kind is None else f"{e.event_type}:{e.kind}"
            for e in self.events(watcher_id)
        ]

    def heartbeats(self, watcher_id: str) -> list[HeartbeatRow]:
        """Every heartbeat the server stored for the watcher, oldest first."""
        rows = self.query(
            """SELECT id, status, timestamp, created_at, upload_mode, files_uploaded_since_last,
                      runs_reported_since_last, errors_since_last, uptime_seconds
               FROM watcher_heartbeats WHERE watcher_id = %s ORDER BY id""",
            (watcher_id,),
        )
        return [HeartbeatRow(*cast("tuple[Any, ...]", r)) for r in rows]

    # ------------------------------------------------------------------
    # Runs and files
    # ------------------------------------------------------------------

    def runs(self, instrument_id: str) -> list[RunRow]:
        """The instrument's runs, deleted ones included, oldest first."""
        rows = self.query(
            """SELECT id::text, instrument_id, run_id, source::text, watcher_id::text,
                      deleted_at, acquired_at
               FROM instrument_runs WHERE instrument_id = %s ORDER BY created_at, run_id""",
            (instrument_id,),
        )
        return [RunRow(*cast("tuple[Any, ...]", r)) for r in rows]

    def files(
        self,
        instrument_id: str,
        run_id: str | None = None,
        *,
        status: str | Iterable[str] | None = None,
        include_deleted: bool = False,
    ) -> list[FileRow]:
        """The instrument's files, oldest first. Dismissed files are left out unless asked for."""
        sql = _FILE_SELECT + " WHERE r.instrument_id = %s"
        params: list[object] = [instrument_id]
        if run_id is not None:
            sql += " AND r.run_id = %s"
            params.append(run_id)
        if status is not None:
            statuses = [status] if isinstance(status, str) else list(status)
            sql += " AND f.status::text = ANY(%s)"
            params.append(statuses)
        if not include_deleted:
            sql += " AND f.deleted_at IS NULL"
        sql += " ORDER BY f.id"
        return [_file_row(r) for r in self.query(sql, tuple(params))]

    def file(
        self, instrument_id: str, run_id: str, relative_path: str, *, include_deleted: bool = True
    ) -> FileRow | None:
        """The file stored for ``relative_path`` in the run (the newest, if a dismissed one
        also sits at that path), or ``None``."""
        sql = (
            _FILE_SELECT + " WHERE r.instrument_id = %s AND r.run_id = %s AND f.relative_path = %s"
        )
        if not include_deleted:
            sql += " AND f.deleted_at IS NULL"
        sql += " ORDER BY f.id DESC LIMIT 1"
        rows = self.query(sql, (instrument_id, run_id, relative_path))
        return _file_row(rows[0]) if rows else None

    def run_status(self, instrument_id: str, run_id: str) -> RunStatus:
        """The run's status, derived from its live raw files the way the web app does it
        (``deriveRunStatus`` in web/lib/runs/run-status.ts, without the stalled state):
        any failed file makes the run ``failed``, then any file still waiting for its upload
        makes it ``pending``, then ``uploaded``, ``processing``, ``completed``, and a run
        with no files is ``empty``."""
        rows = self.query(
            """SELECT DISTINCT f.status::text FROM files f
               JOIN instrument_runs r ON r.id = f.instrument_run_id
               WHERE r.instrument_id = %s AND r.run_id = %s
                 AND f.category = 'raw' AND f.deleted_at IS NULL""",
            (instrument_id, run_id),
        )
        statuses = {cast("str", r[0]) for r in rows}
        if "failed" in statuses:
            return "failed"
        if statuses & {"detected", "upload_requested"}:
            return "pending"
        for status in ("uploaded", "processing", "completed"):
            if status in statuses:
                return cast("RunStatus", status)
        return "empty"

    # ------------------------------------------------------------------
    # Ageing: cross a server timer without waiting for it
    # ------------------------------------------------------------------

    def age_heartbeat(self, watcher_id: str, minutes: float) -> None:
        """Make the watcher's ``last_heartbeat_at`` ``minutes`` old.

        The server calls a watcher stale after 5 minutes (:data:`STALE_AFTER_MINUTES`) and
        its sweep reverts upload requests after 15 (:data:`SWEEP_GRACE_MINUTES`). A running
        watcher sets the column again on its next heartbeat, so stop it first or keep its
        heartbeats away with a proxy fault.
        """
        self.execute(
            "UPDATE watchers SET last_heartbeat_at = now() - (%s * interval '1 minute') "
            "WHERE id = %s",
            (minutes, watcher_id),
        )

    def age_past_stale(self, watcher_id: str) -> None:
        """Age the last heartbeat to just past the stale mark (6 minutes)."""
        self.age_heartbeat(watcher_id, STALE_AFTER_MINUTES + 1)

    def age_past_sweep_grace(self, watcher_id: str) -> None:
        """Age the last heartbeat to just past the cron sweep's grace period (16 minutes)."""
        self.age_heartbeat(watcher_id, SWEEP_GRACE_MINUTES + 1)

    def clear_heartbeat(self, watcher_id: str) -> None:
        """Set ``last_heartbeat_at`` to null, as for a watcher that never checked in."""
        self.execute("UPDATE watchers SET last_heartbeat_at = NULL WHERE id = %s", (watcher_id,))

    def set_instrument_status(self, instrument_id: str, status: str) -> None:
        """Set an instrument's status straight in the database (``pending``, ``active``,
        ``inactive``), without the retirement side effects of the REST route."""
        self.execute("UPDATE instruments SET status = %s WHERE id = %s", (status, instrument_id))

    # ------------------------------------------------------------------
    # The S3 stand-in
    # ------------------------------------------------------------------

    def object_path(self, instrument_id: str, run_id: str, filename: str) -> Path:
        """Where the stand-in stores ``<instrument>/<run>/<filename>``, whether it exists or not."""
        return self.env.s3_mirror_root / self.env.raw_bucket / instrument_id / run_id / filename

    def object_exists(self, instrument_id: str, run_id: str, filename: str) -> bool:
        return self.object_path(instrument_id, run_id, filename).is_file()

    def read_object(self, instrument_id: str, run_id: str, filename: str) -> bytes:
        """The bytes the stand-in holds for the file. Raises ``FileNotFoundError`` if none."""
        return self.object_path(instrument_id, run_id, filename).read_bytes()

    def mirror_listing(self) -> list[tuple[str, int]]:
        """Every object in the stand-in as ``(path under the mirror root, size)``, sorted."""
        root = self.env.s3_mirror_root
        if not root.exists():
            return []
        return sorted(
            (p.relative_to(root).as_posix(), p.stat().st_size)
            for p in root.rglob("*")
            if p.is_file()
        )

    # ------------------------------------------------------------------
    # Waiting for the server to show something
    # ------------------------------------------------------------------

    def dump(self, watcher_id: str | None = None, instrument_id: str | None = None) -> str:
        """A text summary of the watcher, its latest events and heartbeats, and the files.

        Used as the ``describe`` of every ``wait_for_*`` here, so a timeout shows what the
        server had when it gave up.
        """
        lines: list[str] = []
        try:
            if watcher_id is not None:
                w = self.watcher(watcher_id)
                lines.append(
                    f"watcher {w.id}: status={w.status} reason={w.status_reason!r} "
                    f"version={w.watcher_version} revision={w.config_revision}/"
                    f"{w.applied_config_revision} last_heartbeat={w.last_heartbeat_at} "
                    f"deleted={w.deleted_at}"
                )
                events = self.events(watcher_id)
                lines.append(f"events ({len(events)}), newest 25:")
                for e in events[-25:]:
                    lines.append(
                        f"  {e.timestamp:%H:%M:%S} {e.event_type} {e.message[:100]!r} "
                        f"{json.dumps(e.details, default=str)[:160]}"
                    )
                beats = self.heartbeats(watcher_id)
                lines.append(f"heartbeats: {len(beats)}; newest 3:")
                for b in beats[-3:]:
                    lines.append(
                        f"  {b.timestamp:%H:%M:%S} {b.status} "
                        f"uploaded={b.files_uploaded_since_last} "
                        f"runs={b.runs_reported_since_last} errors={b.errors_since_last}"
                    )
            if instrument_id is not None:
                files = self.files(instrument_id, include_deleted=True)
                lines.append(f"files of {instrument_id} ({len(files)}):")
                for f in files:
                    lines.append(
                        f"  #{f.id} run={f.run_id} path={f.relative_path} {f.status} "
                        f"size={f.size_bytes} deleted={f.deleted_at is not None}"
                    )
        except Exception as exc:
            lines.append(f"(could not read the server state: {type(exc).__name__}: {exc})")
        return "\n".join(lines)

    def wait_for_watcher_status(
        self, watcher_id: str, status: str, timeout: float = 30.0
    ) -> WatcherRow:
        """Wait until the stored status is ``status`` and return the row."""

        def found() -> WatcherRow | None:
            row = self.watcher(watcher_id)
            return row if row.status == status else None

        return wait_until(
            found,
            timeout,
            lambda: self.dump(watcher_id),
            what=f"watcher {watcher_id} to be {status!r}",
        )

    def wait_for_effective_status(self, watcher_id: str, status: str, timeout: float = 30.0) -> str:
        """Wait until ``GET /api/v1/watchers/:id`` reports ``status`` (which can be ``stale``)."""

        def found() -> str | None:
            return status if self.effective_status(watcher_id) == status else None

        return wait_until(
            found,
            timeout,
            lambda: self.dump(watcher_id),
            what=f"the effective status of watcher {watcher_id} to be {status!r}",
        )

    def wait_for_events(
        self,
        watcher_id: str,
        *,
        count: int = 1,
        event_type: str | None = None,
        kind: str | None = None,
        message_contains: str | None = None,
        after_id: int = 0,
        timeout: float = 30.0,
    ) -> list[EventRow]:
        """Wait until at least ``count`` events match, and return all that do."""

        def matching() -> list[EventRow]:
            found = self.events(
                watcher_id,
                event_type=event_type,
                kind=kind,
                message_contains=message_contains,
                after_id=after_id,
            )
            return found if len(found) >= count else []

        return wait_until(
            matching,
            timeout,
            lambda: self.dump(watcher_id),
            what=(
                f"{count} event(s) of type={event_type!r} kind={kind!r} "
                f"message_contains={message_contains!r}"
            ),
        )

    def wait_for_event(
        self,
        watcher_id: str,
        *,
        event_type: str | None = None,
        kind: str | None = None,
        message_contains: str | None = None,
        after_id: int = 0,
        timeout: float = 30.0,
    ) -> EventRow:
        """Wait for one matching event and return the oldest."""
        return self.wait_for_events(
            watcher_id,
            event_type=event_type,
            kind=kind,
            message_contains=message_contains,
            after_id=after_id,
            timeout=timeout,
        )[0]

    def wait_for_run(self, instrument_id: str, run_id: str, timeout: float = 30.0) -> RunRow:
        """Wait until the server has a run with this name and return it."""
        return wait_until(
            lambda: next((r for r in self.runs(instrument_id) if r.run_id == run_id), None),
            timeout,
            lambda: self.dump(instrument_id=instrument_id),
            what=f"run {run_id!r} of {instrument_id}",
        )

    def wait_for_file(
        self,
        instrument_id: str,
        run_id: str,
        relative_path: str,
        *,
        status: str | None = None,
        timeout: float = 30.0,
    ) -> FileRow:
        """Wait for the file at ``relative_path`` (and, if given, in ``status``) and return it."""

        def found() -> FileRow | None:
            row = self.file(instrument_id, run_id, relative_path, include_deleted=False)
            return row if row is not None and (status is None or row.status == status) else None

        return wait_until(
            found,
            timeout,
            lambda: self.dump(instrument_id=instrument_id),
            what=f"file {run_id}/{relative_path} to exist" + (f" as {status!r}" if status else ""),
        )

    def wait_for_uploaded(
        self,
        instrument_id: str,
        run_id: str,
        relative_path: str,
        *,
        content: bytes | Path | None = None,
        timeout: float = 60.0,
    ) -> FileRow:
        """Wait until the file is done: its row says ``uploaded`` and the stand-in holds it.

        With ``content`` (the bytes, or the path of the original file), also checks that the
        stored bytes are identical. This is the end-to-end definition of an upload.
        """
        row = self.wait_for_file(
            instrument_id, run_id, relative_path, status="uploaded", timeout=timeout
        )
        assert row.s3_key == f"{instrument_id}/{run_id}/{row.filename}", row.s3_key
        stored = wait_until(
            lambda: self.read_object(instrument_id, run_id, row.filename),
            timeout,
            lambda: "\n".join(f"{p} {n}" for p, n in self.mirror_listing()),
            what=f"the stand-in to hold {row.s3_key}",
        )
        if content is not None:
            expected = content if isinstance(content, bytes) else content.read_bytes()
            assert stored == expected, (
                f"{row.s3_key}: stored {len(stored)} bytes that differ from the "
                f"expected {len(expected)} bytes"
            )
        return row

    def wait_until(
        self,
        predicate: Callable[[], Any],
        timeout: float,
        *,
        what: str,
        watcher_id: str | None = None,
        instrument_id: str | None = None,
    ) -> Any:
        """:func:`e2e_support.waiting.wait_until` whose failure message includes
        :meth:`dump` of the given watcher and instrument."""
        return wait_until(
            predicate,
            timeout,
            lambda: self.dump(watcher_id, instrument_id),
            what=what,
        )
