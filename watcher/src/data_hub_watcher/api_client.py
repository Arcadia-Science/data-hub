from __future__ import annotations
import logging
import os
import time
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, TypeGuard
from urllib.parse import quote, urlsplit

import requests

from data_hub_watcher.constants import (
    MAX_UPLOAD_FAILURES_PER_REQUEST,
    NOT_FOUND_ERROR_CODE,
    RUN_DELETED_REASON,
    UPLOAD_FAILURE_DETAIL_MAX_LENGTH,
    WATCHER_DEREGISTERED_ERROR_CODE,
    WATCHER_VERSION,
    WATCHER_VERSION_HEADER,
)
from data_hub_watcher.models import (
    ApiErrorDetail,
    ConfigChecksumResponse,
    ConfigRevisionResponse,
    EventsResponse,
    FileResponse,
    HeartbeatResponse,
    InstrumentDetailResponse,
    InstrumentResponse,
    MultipartCompleteResponse,
    MultipartPartUrlsResponse,
    PresignedUploadResponse,
    RegisterWatcherResponse,
    RunDetailResponse,
    RunResponse,
    UploadFailuresResponse,
    UploadQueueResponse,
    WatcherResponse,
    WatcherUpdateInfoResponse,
)

logger = logging.getLogger(__name__)


class ApiError(Exception):
    """Raised when the Data Hub API returns a non-2xx response."""

    def __init__(
        self,
        message: str,
        status_code: int = 0,
        detail: ApiErrorDetail | None = None,
        *,
        read_timed_out: bool = False,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.detail = detail
        # True when the request was sent and no answer came back in time. The server may
        # have acted on it, so replaying a request that isn't safe to repeat can do it twice.
        self.read_timed_out = read_timed_out

    @property
    def is_transient(self) -> bool:
        """True when no response came back (status 0) or the server returned a 5xx.

        A 4xx needs someone to fix the cause, and replaying it would fail the same way.
        """
        return self.status_code == 0 or self.status_code >= 500

    @property
    def is_deregistered_reply(self) -> bool:
        """True for the server's reply to a deregistered watcher.

        That is a 404 with the error code `WATCHER_DEREGISTERED`, which Data Hub sends from the
        heartbeat route and `GET /watchers/{id}` when the watcher's registration was deleted.
        A watcher ID that the server has no row for gets a plain `NOT_FOUND` instead, which
        says nothing about this watcher's registration (rows may have gone missing from the
        server's database), and neither does a 404 from anything else on the way, such as an
        HTML page from a proxy or a failed deploy (`detail` is `None`). Any other status or
        code is some other problem. None of those count.
        """
        return (
            self.status_code == 404
            and self.detail is not None
            and self.detail.code == WATCHER_DEREGISTERED_ERROR_CODE
        )


def is_run_deleted(exc: BaseException) -> TypeGuard[ApiError]:
    """True when *exc* is the server's 409 for a request about a run deleted on Data Hub.

    The server marks that 409 with ``error.details.reason``. A 409 without the reason, from
    an older server or for another conflict, is not it.
    """
    if not isinstance(exc, ApiError) or exc.status_code != 409 or exc.detail is None:
        return False
    details = exc.detail.details
    return details is not None and details.get("reason") == RUN_DELETED_REASON


def is_route_missing(exc: ApiError) -> bool:
    """True for a 404 that says the server has no such route, not that a record is missing.

    Data Hub's routes answer a missing record (a watcher ID it has no row for, say) with a JSON
    404 whose code is `NOT_FOUND`. A server that doesn't have the route at all answers with
    Next.js's HTML 404 page, which has no JSON `error` (`detail` is `None`).
    """
    return exc.status_code == 404 and (
        exc.detail is None or exc.detail.code != NOT_FOUND_ERROR_CODE
    )


@dataclass(frozen=True)
class UploadFailure:
    """One file the watcher gave up on, for `report_upload_failures`.

    A file someone requested has its server ID, *file_id*, and *requested_at*, the
    `upload_requested_at` the upload queue listed it with. An auto-mode file is named by
    *relative_path*, because the watcher doesn't know its server ID. *run_id* is sent only for
    an auto-mode file, but every item has it, so the items of one run go in one request.
    *detail* is the last error of an `upload_error`.
    """

    run_id: str
    reason: str
    file_id: int | None = None
    requested_at: str | None = None
    relative_path: str | None = None
    detail: str | None = None

    def payload(self) -> dict[str, Any]:
        """The item as the endpoint takes it."""
        item: dict[str, Any]
        if self.file_id is not None:
            item = {"file_id": self.file_id}
            if self.requested_at is not None:
                item["requested_at"] = self.requested_at
        else:
            item = {"run_id": self.run_id, "relative_path": self.relative_path}
        item["reason"] = self.reason
        if self.detail:
            item["detail"] = self.detail[:UPLOAD_FAILURE_DETAIL_MAX_LENGTH]
        return item


def chunk_upload_failures(
    failures: Sequence[UploadFailure], limit: int = MAX_UPLOAD_FAILURES_PER_REQUEST
) -> list[list[UploadFailure]]:
    """Split *failures* into requests of at most *limit* items.

    Data Hub writes one event and sends one notification per run and reason in each request,
    so a run's items stay together. They are split only when the run alone has more than
    *limit*, and then the run's last, smaller piece can share a request with other runs.
    Runs keep the order they first appear in.
    """
    runs: dict[str, list[UploadFailure]] = {}
    for failure in failures:
        runs.setdefault(failure.run_id, []).append(failure)
    chunks: list[list[UploadFailure]] = []
    current: list[UploadFailure] = []
    for items in runs.values():
        if current and len(current) + len(items) > limit:
            chunks.append(current)
            current = []
        while len(items) > limit:
            chunks.append(items[:limit])
            items = items[limit:]
        current.extend(items)
    if current:
        chunks.append(current)
    return chunks


DEFAULT_TIMEOUT: tuple[float, float] = (5, 30)  # (connect, read) seconds

# Least time a request that must finish by a deadline is given, so a deadline that has
# nearly passed still allows a request to be made.
_MIN_REQUEST_SECONDS = 0.5


def timeout_until(deadline: float, cap: tuple[float, float]) -> tuple[float, float]:
    """The HTTP timeout for a last request that should be done by *deadline*.

    *deadline* is a `time.monotonic()` value and *cap* is the `(connect, read)` timeout the
    request gets when there is plenty of time (`DEFAULT_TIMEOUT`, the client's usual one, or
    `SYSTEM_SHUTDOWN_HTTP_TIMEOUT` for a Windows shutdown). It is cut down so that the
    connect and the read together fit in the time left.
    """
    left = max(deadline - time.monotonic(), _MIN_REQUEST_SECONDS)
    connect = min(cap[0], left / 2)
    read = min(cap[1], left - connect)
    return (connect, read)


def _path_segment(value: str) -> str:
    """Percent-encode *value* so it is one literal segment of a URL path.

    A run ID comes from a folder name, a file name or a custom pattern, so it
    can hold characters that mean something in a URL. Put into a path as it is,
    a `#` ends the path (the rest becomes a fragment that is never sent) and
    `%41` is sent as `A`, so the call reaches another run or none. `requests`
    doesn't encode these for us, so it has to be done here.

    An ID of `.` or `..` still can't reach its run, because `urllib3` removes it
    as a dot segment.
    """
    return quote(value, safe="")


class DataHubClient:
    """HTTP client for the Data Hub API."""

    def __init__(
        self,
        base_url: str,
        api_key: str | None = None,
        timeout: tuple[float, float] = DEFAULT_TIMEOUT,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self._timeout = timeout
        # A persistent session reuses TCP connections across requests, which
        # matters when the watcher is long-running and chatting with the API
        # every heartbeat interval.
        self._session = requests.Session()

        # Allow the API key to be passed explicitly (e.g. during `init`) or
        # fall back to the environment variable for normal operation.
        key = api_key or os.environ.get("DATA_HUB_API_KEY", "")
        if key:
            self._session.headers["Authorization"] = f"Bearer {key}"
        # Every request, not just heartbeats. Upload calls carry no watcher
        # id, so this header is the only way the server can tell a 1.1.0
        # watcher from one that still uploads by bare filename.
        self._session.headers[WATCHER_VERSION_HEADER] = WATCHER_VERSION
        # Set after the first 404 from a config-revision endpoint so an older
        # server doesn't fill the log with the same line every heartbeat.
        self._remote_config_missing_logged = False

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _url(self, path: str) -> str:
        return f"{self.base_url}{path}"

    def _handle_error(self, resp: requests.Response) -> None:
        """Parse an error body and raise `ApiError`."""
        detail: ApiErrorDetail | None = None
        try:
            body = resp.json()
            if "error" in body:
                detail = ApiErrorDetail.model_validate(body["error"])
                msg = detail.message
            else:
                msg = resp.text
        except Exception:
            msg = resp.text
        raise ApiError(msg, status_code=resp.status_code, detail=detail)

    def _request(
        self,
        method: str,
        path: str,
        *,
        json: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
        timeout: tuple[float, float] | None = None,
    ) -> requests.Response:
        try:
            resp = self._session.request(
                method,
                self._url(path),
                json=json,
                params=params,
                timeout=timeout or self._timeout,
            )
        except requests.ConnectionError as exc:
            # Includes a connect timeout, which is both a connection error and a timeout.
            raise ApiError(f"Connection error: {exc}") from exc
        except requests.Timeout as exc:
            # Only a read timeout is left: the request was sent.
            raise ApiError(f"Request timed out: {exc}", read_timed_out=True) from exc

        if not resp.ok:
            self._handle_error(resp)
        return resp

    # ------------------------------------------------------------------
    # Instruments
    # ------------------------------------------------------------------

    def list_instruments(self) -> list[InstrumentResponse]:
        resp = self._request("GET", "/instruments")
        return [InstrumentResponse.model_validate(item) for item in resp.json()]

    def create_instrument(self, id: str, display_name: str | None = None) -> InstrumentResponse:
        payload: dict[str, Any] = {"id": id}
        if display_name:
            payload["display_name"] = display_name
        resp = self._request("POST", "/instruments", json=payload)
        return InstrumentResponse.model_validate(resp.json())

    def get_instrument(self, instrument_id: str) -> InstrumentDetailResponse:
        resp = self._request("GET", f"/instruments/{instrument_id}")
        return InstrumentDetailResponse.model_validate(resp.json())

    # ------------------------------------------------------------------
    # Watchers
    # ------------------------------------------------------------------

    def register_watcher(
        self,
        instrument_id: str,
        hostname: str | None = None,
        os_info: str | None = None,
    ) -> RegisterWatcherResponse:
        payload: dict[str, Any] = {"instrument_id": instrument_id}
        if hostname:
            payload["hostname"] = hostname
        if os_info:
            payload["os_info"] = os_info
        resp = self._request("POST", "/watchers/register", json=payload)
        return RegisterWatcherResponse.model_validate(resp.json())

    def get_watcher(self, watcher_id: str) -> WatcherResponse:
        """Fetch a watcher that is still registered (`GET /watchers/{id}`).

        A deregistered watcher gets a 404 with the code `WATCHER_DEREGISTERED`
        (`ApiError.is_deregistered_reply`), and a watcher ID the server has no row for gets
        `NOT_FOUND`. The watcher's own token has the scope for it, `watchers:read`, which it
        already uses for the upload queue.
        """
        resp = self._request("GET", f"/watchers/{watcher_id}")
        return WatcherResponse.model_validate(resp.json())

    def push_config(
        self,
        watcher_id: str,
        config_yaml: str,
        checksum: str,
        *,
        based_on_revision: int | None = None,
        modified_at: datetime | None = None,
    ) -> ConfigChecksumResponse:
        """Push the local config YAML.

        *based_on_revision* is the highest config revision this watcher had
        applied when the file was written, and *modified_at* is the file's
        modification time. The server uses both to decide whether an edit made
        on the PC while offline wins over a pending change from the web app.
        Older servers ignore both fields.
        """
        payload: dict[str, Any] = {"config_yaml": config_yaml, "config_checksum": checksum}
        if based_on_revision is not None:
            payload["based_on_revision"] = based_on_revision
        if modified_at is not None:
            payload["modified_at"] = modified_at.astimezone(timezone.utc).isoformat()
        resp = self._request("PUT", f"/watchers/{watcher_id}/config", json=payload)
        return ConfigChecksumResponse.model_validate(resp.json())

    def get_latest_config_revision(self, watcher_id: str) -> ConfigRevisionResponse | None:
        """Return the watcher's latest config revision, or `None` if there is none.

        A 404 means either that no revision exists yet or that the server
        predates remote config. Both mean "nothing to apply", so neither is an
        error. The first one is logged once per client, not on every call.
        """
        try:
            resp = self._request("GET", f"/watchers/{watcher_id}/config-revisions/latest")
        except ApiError as exc:
            if exc.status_code == 404:
                self._note_remote_config_missing()
                return None
            raise
        return ConfigRevisionResponse.model_validate(resp.json())

    def report_config_revision_result(
        self,
        watcher_id: str,
        revision: int,
        status: str,
        reason: str | None = None,
    ) -> ConfigRevisionResponse:
        """Tell the server whether *revision* was `applied` or `rejected`."""
        payload: dict[str, Any] = {"status": status}
        if reason:
            # The server caps the reason at 1000 characters.
            payload["reason"] = reason[:1000]
        resp = self._request(
            "POST",
            f"/watchers/{watcher_id}/config-revisions/{revision}/result",
            json=payload,
        )
        return ConfigRevisionResponse.model_validate(resp.json())

    def _note_remote_config_missing(self) -> None:
        if self._remote_config_missing_logged:
            return
        self._remote_config_missing_logged = True
        logger.info(
            "The server has no config revisions for this watcher, or doesn't "
            "support editing watcher config from the web app yet"
        )

    def get_config_checksum(self, watcher_id: str) -> ConfigChecksumResponse | None:
        """Return the remote checksum, or `None` if no config has been pushed.

        A 404 is expected for newly registered watchers that haven't pushed
        config yet — it is not an error condition.
        """
        try:
            resp = self._request("GET", f"/watchers/{watcher_id}/config-checksum")
            return ConfigChecksumResponse.model_validate(resp.json())
        except ApiError as exc:
            if exc.status_code == 404:
                return None
            raise

    def send_heartbeat(
        self,
        watcher_id: str,
        payload: dict[str, Any],
        *,
        timeout: tuple[float, float] | None = None,
    ) -> HeartbeatResponse:
        """Send a heartbeat. *timeout* replaces the client's, for a last one sent in a hurry."""
        resp = self._request(
            "POST", f"/watchers/{watcher_id}/heartbeat", json=payload, timeout=timeout
        )
        return HeartbeatResponse.model_validate(resp.json())

    def send_events(
        self,
        watcher_id: str,
        events: list[dict[str, Any]],
        *,
        timeout: tuple[float, float] | None = None,
    ) -> EventsResponse:
        """Send events. *timeout* replaces the client's, for a last batch sent in a hurry."""
        resp = self._request(
            "POST", f"/watchers/{watcher_id}/events", json={"events": events}, timeout=timeout
        )
        return EventsResponse.model_validate(resp.json())

    def get_update_info(self, watcher_id: str) -> WatcherUpdateInfoResponse:
        """Fetch server-reported watcher release metadata.

        Used by `self-update` and the in-process updater to decide whether
        the running watcher should upgrade itself.
        """
        resp = self._request("GET", f"/watchers/{watcher_id}/update-check")
        return WatcherUpdateInfoResponse.model_validate(resp.json())

    # ------------------------------------------------------------------
    # Runs
    # ------------------------------------------------------------------

    def report_run(self, instrument_id: str, run_data: dict[str, Any]) -> RunResponse:
        resp = self._request("POST", f"/instruments/{instrument_id}/runs", json=run_data)
        return RunResponse.model_validate(resp.json())

    def update_run(
        self, instrument_id: str, run_id: str, data: dict[str, Any]
    ) -> RunDetailResponse:
        resp = self._request(
            "PATCH",
            f"/instruments/{instrument_id}/runs/{_path_segment(run_id)}",
            json=data,
        )
        return RunDetailResponse.model_validate(resp.json())

    # ------------------------------------------------------------------
    # Upload queue / files
    # ------------------------------------------------------------------

    def get_upload_queue(self, watcher_id: str) -> UploadQueueResponse:
        resp = self._request("GET", f"/watchers/{watcher_id}/upload-queue")
        return UploadQueueResponse.model_validate(resp.json())

    def report_upload_failures(
        self, watcher_id: str, failures: Sequence[UploadFailure]
    ) -> UploadFailuresResponse | None:
        """Tell Data Hub which files the watcher gave up on, so it marks them `upload_failed`.

        Sent in requests of up to `MAX_UPLOAD_FAILURES_PER_REQUEST` files, each run's files
        in one request where they fit (`chunk_upload_failures`), and the counts of every
        request are added up. Returns `None` when the server has no such endpoint
        (`is_route_missing`): it is older than watcher 1.4.5, and the caller falls back to
        cancelling each request on its own. Any other error is raised at the first request
        that fails. The server skips a file it has already marked, so sending again the
        requests that went through before it is safe.
        """
        failed = skipped = 0
        for chunk in chunk_upload_failures(failures):
            try:
                resp = self._request(
                    "POST",
                    f"/watchers/{watcher_id}/upload-failures",
                    json={"files": [failure.payload() for failure in chunk]},
                )
            except ApiError as exc:
                if is_route_missing(exc):
                    return None
                raise
            counts = UploadFailuresResponse.model_validate(resp.json())
            failed += counts.failed
            skipped += counts.skipped
        return UploadFailuresResponse(failed=failed, skipped=skipped)

    def request_upload_url(
        self,
        instrument_id: str,
        run_id: str,
        filename: str,
        content_type: str | None = None,
        size_bytes: int | None = None,
        file_created_at_ts: float | None = None,
        relative_path: str | None = None,
    ) -> PresignedUploadResponse:
        payload: dict[str, Any] = {"filename": filename}
        if content_type:
            payload["content_type"] = content_type
        if size_bytes is not None:
            payload["size_bytes"] = size_bytes
        # Lets the server tell two same-named files in different folders
        # apart. Older servers ignore the field.
        if relative_path:
            payload["relative_path"] = relative_path
        if file_created_at_ts:
            payload["file_created_at"] = datetime.fromtimestamp(
                file_created_at_ts, tz=timezone.utc
            ).isoformat()
        resp = self._request(
            "POST",
            f"/instruments/{instrument_id}/runs/{_path_segment(run_id)}/request-upload-url",
            json=payload,
        )
        parsed = PresignedUploadResponse.model_validate(resp.json())
        if parsed.upload_url:
            parsed.upload_url = self._absolute_url(parsed.upload_url)
        return parsed

    def _absolute_url(self, url: str) -> str:
        # The local S3 stand-in returns a same-origin path. S3 returns https.
        if url.startswith("/"):
            # Part URLs are rooted at the site (`/api/local-s3/...`), not at
            # the `/api/v1` prefix stored on this client.
            parsed = urlsplit(self.base_url)
            return f"{parsed.scheme}://{parsed.netloc}{url}"
        return url

    def get_part_urls(
        self, file_id: int, upload_id: str, part_numbers: list[int]
    ) -> MultipartPartUrlsResponse:
        resp = self._request(
            "POST",
            f"/files/{file_id}/multipart-upload/part-urls",
            json={"upload_id": upload_id, "part_numbers": part_numbers},
        )
        parsed = MultipartPartUrlsResponse.model_validate(resp.json())
        for part in parsed.parts:
            part.upload_url = self._absolute_url(part.upload_url)
        return parsed

    def complete_multipart_upload(
        self,
        file_id: int,
        upload_id: str,
        parts: list[dict[str, Any]],
        checksum_crc64nvme: str,
    ) -> MultipartCompleteResponse:
        # Assembly can take minutes. Match the route's five-minute limit.
        resp = self._request(
            "POST",
            f"/files/{file_id}/multipart-upload/complete",
            json={
                "upload_id": upload_id,
                "parts": parts,
                "checksum_crc64nvme": checksum_crc64nvme,
            },
            timeout=(5, 300),
        )
        return MultipartCompleteResponse.model_validate(resp.json())

    def abort_multipart_upload(self, file_id: int, upload_id: str) -> None:
        self._request(
            "DELETE",
            f"/files/{file_id}/multipart-upload",
            json={"upload_id": upload_id},
        )

    def mark_file_uploaded(self, file_id: int, updates: dict[str, Any]) -> FileResponse:
        resp = self._request("PATCH", f"/files/{file_id}", json=updates)
        return FileResponse.model_validate(resp.json())

    def cancel_upload_request(self, file_id: int) -> FileResponse:
        """Revert a queued file to ``detected`` so it leaves the upload queue.

        The fallback for a server older than watcher 1.4.5, which has no
        `report_upload_failures` endpoint. Called after the watcher gives up on
        a queued file (missing on disk or persistently failing to upload) so
        the server stops serving it in the upload queue. The file stays a
        re-requestable detection rather than being deleted, so an operator can
        queue it again later.
        """
        resp = self._request("PATCH", f"/files/{file_id}", json={"status": "detected"})
        return FileResponse.model_validate(resp.json())
