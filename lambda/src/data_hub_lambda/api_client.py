"""HTTP client for the Data Hub API — Lambda-specific endpoints.

Mirrors the watcher's ``api_client.py`` structure with methods tailored to
the Lambda's per-file processing workflow.
"""

from __future__ import annotations
import logging
import os
from typing import Any

import requests

from data_hub_lambda.models import ApiErrorDetail, FileResponse, RunResponse

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


DEFAULT_TIMEOUT: tuple[float, float] = (5, 30)


class DataHubClient:
    """HTTP client for the Data Hub API (Lambda caller)."""

    def __init__(
        self,
        base_url: str,
        api_key: str | None = None,
        timeout: tuple[float, float] = DEFAULT_TIMEOUT,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._session = requests.Session()

        key = api_key or os.environ.get("DATA_HUB_API_KEY", "")
        if key:
            self._session.headers["Authorization"] = f"Bearer {key}"
        self._session.headers["Content-Type"] = "application/json"

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _url(self, path: str) -> str:
        return f"{self.base_url}{path}"

    def _handle_error(self, resp: requests.Response) -> None:
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
    ) -> requests.Response:
        try:
            resp = self._session.request(method, self._url(path), json=json, timeout=self._timeout)
        except requests.ConnectionError as exc:
            raise ApiError(f"Connection error: {exc}") from exc
        except requests.Timeout as exc:
            raise ApiError(f"Request timed out: {exc}") from exc

        if not resp.ok:
            self._handle_error(resp)
        return resp

    # ------------------------------------------------------------------
    # Runs
    # ------------------------------------------------------------------

    def ensure_run(self, instrument_id: str, run_id: str) -> RunResponse:
        """Upsert an instrument run (idempotent on instrument_id + run_id)."""
        resp = self._request(
            "POST",
            f"/instruments/{instrument_id}/runs",
            json={"run_id": run_id, "source": "lambda"},
        )
        return RunResponse.model_validate(resp.json())

    # ------------------------------------------------------------------
    # Files
    # ------------------------------------------------------------------

    def create_file(
        self,
        instrument_id: str,
        run_id: str,
        s3_bucket: str,
        s3_key: str,
        filename: str,
        *,
        content_type: str | None = None,
        size_bytes: int | None = None,
        category: str = "raw",
    ) -> FileResponse:
        """Create a file record (idempotent on s3_key)."""
        payload: dict[str, Any] = {
            "s3_bucket": s3_bucket,
            "s3_key": s3_key,
            "filename": filename,
            "category": category,
        }
        if content_type:
            payload["content_type"] = content_type
        if size_bytes is not None:
            payload["size_bytes"] = size_bytes

        resp = self._request(
            "POST",
            f"/instruments/{instrument_id}/runs/{run_id}/files",
            json=payload,
        )
        return FileResponse.model_validate(resp.json())

    def update_file(
        self,
        file_id: int,
        *,
        status: str | None = None,
        metadata: dict[str, Any] | None = None,
        report_data: list[dict[str, Any]] | None = None,
        error_message: str | None = None,
    ) -> FileResponse:
        """Update a file record (status transition, metadata, report data)."""
        payload: dict[str, Any] = {}
        if status is not None:
            payload["status"] = status
        if metadata is not None:
            payload["metadata"] = metadata
        if report_data is not None:
            payload["report_data"] = report_data
        if error_message is not None:
            payload["error_message"] = error_message

        resp = self._request("PATCH", f"/files/{file_id}", json=payload)
        return FileResponse.model_validate(resp.json())
