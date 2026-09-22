from __future__ import annotations
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

# Allow extra fields so the client doesn't break when the API adds new
# response fields that haven't been modeled here yet.
_API_MODEL_CONFIG = ConfigDict(extra="ignore")


class ApiErrorDetail(BaseModel):
    model_config = _API_MODEL_CONFIG

    code: str
    message: str
    details: dict | None = None


class InstrumentResponse(BaseModel):
    model_config = _API_MODEL_CONFIG

    id: str
    display_name: str
    status: str
    instrument_type: str


class RunResponse(BaseModel):
    model_config = _API_MODEL_CONFIG

    id: str
    instrument_id: str
    run_id: str
    source: str
    metadata: dict = Field(default_factory=dict)


class FileResponse(BaseModel):
    model_config = _API_MODEL_CONFIG

    id: int
    instrument_run_id: str
    filename: str
    # Folder the watcher reported. Empty or equal to `filename` for a file
    # that sits directly in the watch directory. DishCam uses it to pair a
    # stack with the `run.json` from the same capture folder.
    relative_path: str | None = None
    s3_bucket: str | None = None
    s3_key: str | None = None
    content_type: str | None = None
    size_bytes: int | None = None
    category: str
    status: str
    metadata: dict = Field(default_factory=dict)
    error_message: str | None = None
    uploaded_at: datetime | None = None
    processed_at: datetime | None = None
    created_at: datetime | None = None


class RunDetailFile(BaseModel):
    """One file inside GET run detail.

    That payload has no `instrument_run_id` and no `s3_bucket`, so it cannot
    reuse `FileResponse`. `deleted_at` defaults to None so a server that has
    not shipped the field yet still parses.
    """

    model_config = _API_MODEL_CONFIG

    id: int
    filename: str
    relative_path: str | None = None
    s3_key: str | None = None
    category: str
    status: str
    metadata: dict = Field(default_factory=dict)
    deleted_at: datetime | None = None


class RunDetailResponse(RunResponse):
    """GET run detail. `files` is what DishCam uses to pair a capture."""

    files: list[RunDetailFile] = Field(default_factory=list)
