from __future__ import annotations
import logging
import os
import time
from typing import Any

import requests

from data_hub_lambda.models import (
    ApiErrorDetail,
    FileResponse,
    InstrumentResponse,
    RunResponse,
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


# (connect_timeout, read_timeout) in seconds. The read timeout is generous
# because the runs and files endpoints perform upsert queries under the hood.
DEFAULT_TIMEOUT: tuple[float, float] = (5, 30)

# One short in-invocation retry for blips. Longer outages rely on Lambda's
# async retries for S3 events — those waits are free; time.sleep here bills
# at the function's full memory size.
_GET_INSTRUMENT_ATTEMPTS = 2
_GET_INSTRUMENT_BACKOFF_SECONDS = (0.5,)

# Warm-container cache: multi-file runs hit the same instrument repeatedly.
_INSTRUMENT_CACHE_TTL_SECONDS = 60.0
_instrument_cache: dict[str, tuple[float, InstrumentResponse]] = {}


def clear_instrument_cache() -> None:
    """Drop cached instrument lookups (tests / type edits mid-invocation)."""
    _instrument_cache.clear()


class DataHubClient:
    """HTTP client for the Data Hub API (Lambda caller)."""

    def __init__(
        self,
        base_url: str,
        api_key: str | None = None,
        timeout: tuple[float, float] = DEFAULT_TIMEOUT,
    ) -> None:
        # base_url should include the API version prefix (e.g.,
        # "https://datahub.example.com/api/v1") — method paths
        # are appended relative to it.
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
    # Instruments
    # ------------------------------------------------------------------

    def get_instrument(self, instrument_id: str) -> InstrumentResponse:
        """Fetch an instrument by ID, with one short retry on transient errors.

        Retries connection errors, timeouts, and 5xx once after a brief sleep.
        404 and 401/403 are raised immediately so the handler can classify
        them. Exhausted transient failures are re-raised so S3-triggered
        invocations can use Lambda's async retries (unbilled backoff).
        Successful responses are cached for ``_INSTRUMENT_CACHE_TTL_SECONDS``
        so a multi-file run does not re-fetch the same instrument per file.
        """
        now = time.monotonic()
        cached = _instrument_cache.get(instrument_id)
        if cached is not None:
            cached_at, instrument = cached
            if now - cached_at < _INSTRUMENT_CACHE_TTL_SECONDS:
                return instrument

        last_error: ApiError | None = None
        for attempt in range(_GET_INSTRUMENT_ATTEMPTS):
            try:
                resp = self._request("GET", f"/instruments/{instrument_id}")
                instrument = InstrumentResponse.model_validate(resp.json())
                _instrument_cache[instrument_id] = (time.monotonic(), instrument)
                return instrument
            except ApiError as exc:
                last_error = exc
                is_transient = exc.status_code == 0 or exc.status_code >= 500
                if not is_transient or attempt == _GET_INSTRUMENT_ATTEMPTS - 1:
                    raise
                delay = _GET_INSTRUMENT_BACKOFF_SECONDS[attempt]
                logger.warning(
                    "Transient error fetching instrument %s (attempt %d/%d): %s; retrying in %.1fs",
                    instrument_id,
                    attempt + 1,
                    _GET_INSTRUMENT_ATTEMPTS,
                    exc,
                    delay,
                )
                time.sleep(delay)
        # The loop always returns or raises; keep a real raise for -O.
        if last_error is None:
            raise RuntimeError("get_instrument retry loop completed without result")
        raise last_error

    # ------------------------------------------------------------------
    # Runs
    # ------------------------------------------------------------------

    def ensure_run(self, instrument_id: str, run_id: str) -> RunResponse:
        """Upsert an instrument run (idempotent on instrument_id + run_id).

        If the watcher already created the run, returns the existing record.
        If no run exists (e.g., direct S3 upload), auto-creates it with
        `source: "lambda"` so it shows the correct origin in the UI.
        """
        resp = self._request(
            "POST",
            f"/instruments/{instrument_id}/runs",
            json={"run_id": run_id, "source": "lambda"},
        )
        return RunResponse.model_validate(resp.json())

    def update_run(
        self,
        instrument_id: str,
        run_id: str,
        *,
        metadata: dict[str, Any] | None = None,
    ) -> RunResponse:
        """Update an instrument run (currently supports metadata only).

        Metadata is a full replacement — the API does not deep-merge.  The
        Lambda typically calls this once per run after processing the file(s)
        that contribute run-level metadata.
        """
        payload: dict[str, Any] = {}
        if metadata is not None:
            payload["metadata"] = metadata

        resp = self._request(
            "PATCH",
            f"/instruments/{instrument_id}/runs/{run_id}",
            json=payload,
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
        """Create a file record (idempotent on s3_key).

        The API creates the file in `uploaded` status because the file is
        already in S3 when the Lambda is triggered. If the watcher already
        created a record for this `s3_key`, the existing record is returned.
        """
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
        error_message: str | None = None,
        size_bytes: int | None = None,
        content_type: str | None = None,
    ) -> FileResponse:
        """Update a file record (status transition, metadata, S3 object properties).

        The API enforces a state machine: uploaded → processing → completed|failed.
        `size_bytes` and `content_type` are objective properties of the S3 object
        and may be PATCHed after the record is created (e.g. for processed
        artifacts whose size is only known post-upload).
        """
        payload: dict[str, Any] = {}
        if status is not None:
            payload["status"] = status
        if metadata is not None:
            payload["metadata"] = metadata
        if error_message is not None:
            payload["error_message"] = error_message
        if size_bytes is not None:
            payload["size_bytes"] = size_bytes
        if content_type is not None:
            payload["content_type"] = content_type

        resp = self._request("PATCH", f"/files/{file_id}", json=payload)
        return FileResponse.model_validate(resp.json())

    # ------------------------------------------------------------------
    # Archive jobs
    # ------------------------------------------------------------------

    def update_archive_job(
        self,
        job_id: str,
        *,
        status: str,
        archive_bucket: str | None = None,
        archive_key: str | None = None,
        size_bytes: int | None = None,
        error_message: str | None = None,
    ) -> None:
        """PATCH the archive-job row with the final build outcome.

        Authenticates with the standard ``DATA_HUB_API_KEY`` PAT — same
        credential used for every other Lambda → API call. The response
        body is discarded; callers only care that the PATCH didn't raise.
        """
        payload: dict[str, Any] = {"status": status}
        if archive_bucket is not None:
            payload["archive_bucket"] = archive_bucket
        if archive_key is not None:
            payload["archive_key"] = archive_key
        if size_bytes is not None:
            payload["size_bytes"] = size_bytes
        if error_message is not None:
            payload["error_message"] = error_message

        self._request("PATCH", f"/archive-jobs/{job_id}", json=payload)


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

_client: DataHubClient | None = None


def get_client() -> DataHubClient:
    """Return a module-level `DataHubClient` singleton.

    The client is created lazily on first call so that environment variables
    are read after the Lambda runtime has injected them.
    """
    global _client
    if _client is None:
        from data_hub_lambda.config import lambda_config

        _client = DataHubClient(
            base_url=lambda_config.DATA_HUB_API_URL or "",
            api_key=lambda_config.DATA_HUB_API_KEY,
        )
    return _client
