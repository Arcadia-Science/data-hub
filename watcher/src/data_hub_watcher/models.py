from __future__ import annotations
import fnmatch
import logging
import re
from datetime import datetime
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Config models
# ---------------------------------------------------------------------------


class RunDetectionConfig(BaseModel):
    method: Literal["prefix", "directory"]
    prefix_pattern: str | None = None

    @field_validator("prefix_pattern", mode="before")
    @classmethod
    def _default_prefix_pattern(cls, v: str | None, info: object) -> str | None:
        return v

    @model_validator(mode="after")
    def _validate_prefix_pattern(self) -> RunDetectionConfig:
        # Prefix mode requires exactly one capture group in the regex — that
        # group is the run ID. This is validated eagerly at config load time
        # so the user gets a clear error rather than a silent mismatch at runtime.
        if self.method == "prefix":
            pat = self.prefix_pattern or r"^([^_]+)"
            try:
                compiled = re.compile(pat)
            except re.error as exc:
                raise ValueError(f"Invalid prefix_pattern regex: {exc}") from exc
            groups = compiled.groups
            if groups != 1:
                raise ValueError(f"prefix_pattern must have exactly 1 capture group, got {groups}")
            self.prefix_pattern = pat
        return self


class InstrumentConfig(BaseModel):
    id: str
    watch_directory: Path
    file_patterns: list[str] = Field(min_length=1)
    enabled: bool = True
    upload_mode: Literal["auto", "manual"] = "auto"
    stability_period_seconds: int = Field(default=5, ge=1, le=300)
    run_detection: RunDetectionConfig

    @field_validator("id")
    @classmethod
    def _validate_kebab_case(cls, v: str) -> str:
        if not re.match(r"^[a-z0-9]+(-[a-z0-9]+)*$", v):
            raise ValueError(f"Instrument id must be kebab-case (a-z, 0-9, hyphens): {v!r}")
        return v

    @field_validator("watch_directory")
    @classmethod
    def _validate_directory(cls, v: Path) -> Path:
        expanded = Path(str(v)).expanduser().resolve()
        if not expanded.exists():
            raise ValueError(f"Watch directory does not exist: {expanded}")
        if not expanded.is_dir():
            raise ValueError(f"Watch directory is not a directory: {expanded}")
        return expanded


class WatcherConfig(BaseModel):
    version: Literal[1]
    environment: Literal["staging", "production", "preview"]
    api_base_url: str | None = None
    watcher_id: str | None = None
    instrument: InstrumentConfig

    @model_validator(mode="after")
    def _validate_preview_url(self) -> WatcherConfig:
        if self.environment == "preview" and not self.api_base_url:
            raise ValueError("api_base_url is required when environment is 'preview'")
        return self

    @model_validator(mode="after")
    def _emit_warnings(self) -> WatcherConfig:
        # Surface common misconfigurations as warnings at load time rather
        # than silently doing nothing when the watcher starts.
        if not self.instrument.enabled:
            logger.warning("Instrument %r is disabled in config", self.instrument.id)
        watch_dir = self.instrument.watch_directory
        if watch_dir.exists():
            patterns = self.instrument.file_patterns
            has_match = any(
                fnmatch.fnmatch(entry.name, pat)
                for entry in watch_dir.iterdir()
                if entry.is_file()
                for pat in patterns
            )
            if not has_match:
                logger.warning(
                    "Watch directory %s contains no files matching patterns %s",
                    watch_dir,
                    patterns,
                )
        return self


# ---------------------------------------------------------------------------
# API response models
# ---------------------------------------------------------------------------

# API responses may contain fields the watcher doesn't know about yet
# (e.g. after a server-side schema change). "ignore" extra fields so the
# watcher keeps working without requiring a synchronized release.
_API_MODEL_CONFIG = ConfigDict(extra="ignore")


class InstrumentResponse(BaseModel):
    model_config = _API_MODEL_CONFIG

    id: str
    display_name: str
    status: Literal["pending", "active", "inactive"]
    file_patterns: list[str] | None = None
    s3_trigger_suffix: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class InstrumentDetailResponse(InstrumentResponse):
    run_count: int
    watcher_count: int


class RegisterWatcherResponse(BaseModel):
    model_config = _API_MODEL_CONFIG

    watcher_id: str


class ConfigChecksumResponse(BaseModel):
    model_config = _API_MODEL_CONFIG

    config_checksum: str


class HeartbeatResponse(BaseModel):
    model_config = _API_MODEL_CONFIG

    ok: bool


class EventsResponse(BaseModel):
    model_config = _API_MODEL_CONFIG

    received: int


class RunResponse(BaseModel):
    model_config = _API_MODEL_CONFIG

    id: str
    instrument_id: str
    run_id: str
    source: Literal["lambda", "watcher"]


class RunDetailResponse(BaseModel):
    model_config = _API_MODEL_CONFIG

    id: str
    instrument_id: str
    instrument_display_name: str
    run_id: str
    source: Literal["lambda", "watcher"]
    watcher_id: str | None = None
    metadata: dict = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None = None


class UploadQueueFile(BaseModel):
    model_config = _API_MODEL_CONFIG

    id: int
    instrument_id: str
    run_id: str
    relative_path: str | None = None
    filename: str
    size_bytes: int | None = None


class UploadQueueResponse(BaseModel):
    model_config = _API_MODEL_CONFIG

    files: list[UploadQueueFile]


class FileResponse(BaseModel):
    model_config = _API_MODEL_CONFIG

    id: int
    instrument_run_id: str
    filename: str
    relative_path: str | None = None
    s3_bucket: str | None = None
    s3_key: str | None = None
    content_type: str | None = None
    size_bytes: int | None = None
    category: Literal["raw", "processed"]
    status: Literal[
        "detected",
        "upload_requested",
        "uploaded",
        "processing",
        "completed",
        "failed",
    ]
    metadata: dict = Field(default_factory=dict)
    error_message: str | None = None
    detected_at: datetime | None = None
    upload_requested_at: datetime | None = None
    uploaded_at: datetime | None = None
    processed_at: datetime | None = None
    created_at: datetime


class PresignedUploadResponse(BaseModel):
    model_config = _API_MODEL_CONFIG

    upload_url: str | None = None
    s3_bucket: str
    s3_key: str
    file_id: int
    expires_in: int | None = None
    already_uploaded: bool = False


class ApiErrorDetail(BaseModel):
    model_config = _API_MODEL_CONFIG

    code: str
    message: str
    details: dict | None = None
