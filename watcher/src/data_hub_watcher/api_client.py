from __future__ import annotations
import logging
import os
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit

import requests

from data_hub_watcher.constants import WATCHER_VERSION, WATCHER_VERSION_HEADER
from data_hub_watcher.models import (
    ApiErrorDetail,
    ConfigChecksumResponse,
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
    UploadQueueResponse,
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
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.detail = detail


DEFAULT_TIMEOUT: tuple[float, float] = (5, 30)  # (connect, read) seconds


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
            raise ApiError(f"Connection error: {exc}") from exc
        except requests.Timeout as exc:
            raise ApiError(f"Request timed out: {exc}") from exc

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

    def push_config(
        self, watcher_id: str, config_yaml: str, checksum: str
    ) -> ConfigChecksumResponse:
        resp = self._request(
            "PUT",
            f"/watchers/{watcher_id}/config",
            json={"config_yaml": config_yaml, "config_checksum": checksum},
        )
        return ConfigChecksumResponse.model_validate(resp.json())

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

    def send_heartbeat(self, watcher_id: str, payload: dict[str, Any]) -> HeartbeatResponse:
        resp = self._request("POST", f"/watchers/{watcher_id}/heartbeat", json=payload)
        return HeartbeatResponse.model_validate(resp.json())

    def send_events(self, watcher_id: str, events: list[dict[str, Any]]) -> EventsResponse:
        resp = self._request("POST", f"/watchers/{watcher_id}/events", json={"events": events})
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
        resp = self._request("PATCH", f"/instruments/{instrument_id}/runs/{run_id}", json=data)
        return RunDetailResponse.model_validate(resp.json())

    # ------------------------------------------------------------------
    # Upload queue / files
    # ------------------------------------------------------------------

    def get_upload_queue(self, watcher_id: str) -> UploadQueueResponse:
        resp = self._request("GET", f"/watchers/{watcher_id}/upload-queue")
        return UploadQueueResponse.model_validate(resp.json())

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
            f"/instruments/{instrument_id}/runs/{run_id}/request-upload-url",
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

        Called after the watcher gives up on a queued file (missing on disk
        or persistently failing to upload) so the server stops serving it in
        the upload queue and the watcher stops re-erroring on it every
        heartbeat poll. The file stays a re-requestable detection
        rather than being deleted, so an operator can queue it again later.
        """
        resp = self._request("PATCH", f"/files/{file_id}", json={"status": "detected"})
        return FileResponse.model_validate(resp.json())
