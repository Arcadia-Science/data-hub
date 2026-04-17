from __future__ import annotations
import logging
import os
from typing import Any

import requests

from data_hub_watcher.models import (
    ApiErrorDetail,
    ConfigChecksumResponse,
    EventsResponse,
    FileResponse,
    HeartbeatResponse,
    InstrumentDetailResponse,
    InstrumentResponse,
    PresignedUploadResponse,
    RegisterWatcherResponse,
    RunDetailResponse,
    RunResponse,
    UploadQueueResponse,
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
    ) -> requests.Response:
        try:
            resp = self._session.request(
                method, self._url(path), json=json, params=params, timeout=self._timeout
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
    ) -> PresignedUploadResponse:
        payload: dict[str, Any] = {"filename": filename}
        if content_type:
            payload["content_type"] = content_type
        if size_bytes is not None:
            payload["size_bytes"] = size_bytes
        resp = self._request(
            "POST",
            f"/instruments/{instrument_id}/runs/{run_id}/request-upload-url",
            json=payload,
        )
        return PresignedUploadResponse.model_validate(resp.json())

    def mark_file_uploaded(self, file_id: int, s3_info: dict[str, Any]) -> FileResponse:
        resp = self._request("PATCH", f"/files/{file_id}", json=s3_info)
        return FileResponse.model_validate(resp.json())
