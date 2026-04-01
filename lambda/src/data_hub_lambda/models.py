"""Pydantic response models for the Data Hub API (Lambda client)."""

from __future__ import annotations
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

_API_MODEL_CONFIG = ConfigDict(extra="ignore")


class ApiErrorDetail(BaseModel):
    model_config = _API_MODEL_CONFIG

    code: str
    message: str
    details: dict | None = None


class RunResponse(BaseModel):
    model_config = _API_MODEL_CONFIG

    id: str
    instrument_id: str
    run_id: str
    source: str


class FileResponse(BaseModel):
    model_config = _API_MODEL_CONFIG

    id: int
    instrument_run_id: str
    filename: str
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
