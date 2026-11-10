from __future__ import annotations
import fnmatch
import logging
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from data_hub_watcher.constants import MAX_STABILITY_WAIT_SECONDS

logger = logging.getLogger(__name__)


def check_run_pattern(v: str) -> str:
    """Raise `ValueError` unless *v* compiles with exactly one capture group."""
    try:
        compiled = re.compile(v)
    except re.error as exc:
        raise ValueError(f"Invalid run_detection.pattern regex: {exc}") from exc
    if compiled.groups != 1:
        raise ValueError(
            f"run_detection.pattern must have exactly 1 capture group, got {compiled.groups}"
        )
    return v


def watch_directory_problem(path: Path) -> str | None:
    """Return why *path* can't be watched, or `None` if it can.

    Used at startup (a problem puts the watcher in its waiting state), when
    applying a config revision from the web app (a problem rejects it), and by
    `config validate`, `init` and `config edit` so operators at the PC are told.
    The messages start with ``watch_directory`` so they read well as the
    heartbeat's ``status_reason`` and a rejected revision's reason.
    """
    try:
        if not path.exists():
            return f"watch_directory not found: {path}"
        if not path.is_dir():
            return f"watch_directory is not a folder: {path}"
        # `os.access` can report a folder as readable when an ACL denies
        # listing it, so try to list it.
        with os.scandir(path) as it:
            next(it, None)
    except OSError as exc:
        return f"watch_directory is not readable: {path} ({exc.strerror or exc})"
    return None


# ---------------------------------------------------------------------------
# Config models
# ---------------------------------------------------------------------------


class RunDetectionConfig(BaseModel):
    pattern: str
    recursive: bool = True

    @field_validator("pattern")
    @classmethod
    def _one_capture_group(cls, v: str) -> str:
        return check_run_pattern(v)


class InstrumentConfig(BaseModel):
    id: str
    watch_directory: Path
    file_patterns: list[str] = Field(min_length=1)
    enabled: bool = True
    upload_mode: Literal["auto", "manual"] = "auto"
    stability_period_seconds: int = Field(default=5, ge=1, le=300)
    # Cap on how long a still-changing file may stay pending before the
    # monitor abandons it with a stability_timeout event. Defaults to
    # MAX_STABILITY_WAIT_SECONDS so existing YAMLs keep today's 5-minute
    # behaviour; raise for instruments that write large files for longer.
    max_stability_wait_seconds: int = Field(default=MAX_STABILITY_WAIT_SECONDS, ge=1, le=86400)
    # The most S3 uploads the watcher runs at once. Whole files and the parts
    # of a large file share this one budget, across auto mode, the upload
    # queue, pending-upload retries and the one-shot `upload` command (parts
    # count from watcher 1.3.0; before that it only limited files). The
    # default of 4 balances S3 throughput against lab-PC network and CPU
    # budgets; instruments on slow shared uplinks can dial it down to 1 and
    # PCs with fast links can push toward the cap. Defaulted, so existing
    # config YAMLs need no migration.
    upload_parallelism: int = Field(default=4, ge=1, le=32)
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
        # Existence is checked at runtime (see `watch_directory_problem`), not
        # here: a missing folder must not stop the config from loading, so the
        # watcher can start in its waiting state and pick up a fix from the
        # web app.
        return Path(str(v)).expanduser().resolve()

    @model_validator(mode="after")
    def _max_wait_covers_stability_period(self) -> InstrumentConfig:
        # A file must stay unchanged for stability_period_seconds before
        # it can become stable; if the abandon cap is shorter, every file
        # that takes any time to finish writing would time out first.
        if self.max_stability_wait_seconds < self.stability_period_seconds:
            raise ValueError(
                "max_stability_wait_seconds "
                f"({self.max_stability_wait_seconds}) must be >= "
                f"stability_period_seconds ({self.stability_period_seconds})"
            )
        return self


class WatcherConfig(BaseModel):
    version: Literal[1]
    environment: Literal["staging", "production", "preview"]
    # One API base URL per environment, keyed by the `environment` literal, so
    # a single PC can switch between staging/production/preview without
    # re-entering the URL each time. There is no baked-in default: every
    # environment a host actually uses must have its URL set (prompted at
    # `init`, reused on switch). The active environment's URL is exposed via
    # the `api_base_url` property below.
    api_base_urls: dict[str, str] = Field(default_factory=dict)
    # One watcher_id per environment so a single PC can switch between
    # staging/production/preview without losing the registration it already
    # holds in each. Keyed by the `environment` literal.
    watcher_ids: dict[str, str] = Field(default_factory=dict)
    # When None, the effective mode is derived from `environment` (see
    # `resolve_initial_scan`): production uploads its existing backlog, other
    # environments skip it. Set explicitly to override per host.
    initial_scan: Literal["full", "new-only"] | None = None
    instrument: InstrumentConfig

    @model_validator(mode="before")
    @classmethod
    def _migrate_legacy_fields(cls, data: Any) -> Any:
        # Pre-multi-env configs (and pre-multi-env constructor calls) carry
        # single top-level `watcher_id` / `api_base_url` scalars. Lift them
        # into their per-environment maps under the active environment so
        # on-disk configs (and legacy `api_base_url=` kwargs) migrate
        # transparently on load.
        if not isinstance(data, dict):
            return data
        env = data.get("environment")
        if "watcher_id" in data and "watcher_ids" not in data:
            legacy = data.pop("watcher_id")
            if legacy and env:
                data["watcher_ids"] = {env: legacy}
        if "api_base_url" in data and "api_base_urls" not in data:
            legacy_url = data.pop("api_base_url")
            if legacy_url and env:
                data["api_base_urls"] = {env: legacy_url}
        elif "api_base_url" in data:
            # Both the scalar and the map were supplied; drop the scalar so it
            # isn't flagged as an unexpected field.
            data.pop("api_base_url")
        return data

    @property
    def watcher_id(self) -> str | None:
        """The watcher_id registered for the active environment, if any."""
        return self.watcher_ids.get(self.environment)

    @property
    def api_base_url(self) -> str | None:
        """The API base URL configured for the active environment, if any."""
        return self.api_base_urls.get(self.environment)

    def resolve_initial_scan(self) -> Literal["full", "new-only"]:
        """Effective initial-scan mode, defaulting by environment when unset.

        Production is the source of truth and must upload everything on disk;
        staging/preview only want activity that happens after the switch, so
        they default to skipping the pre-existing backlog.
        """
        if self.initial_scan is not None:
            return self.initial_scan
        return "full" if self.environment == "production" else "new-only"

    @model_validator(mode="after")
    def _emit_warnings(self) -> WatcherConfig:
        # Surface common misconfigurations as warnings at load time rather
        # than silently doing nothing when the watcher starts.
        if not self.instrument.enabled:
            logger.warning("Instrument %r is disabled in config", self.instrument.id)
        watch_dir = self.instrument.watch_directory
        problem = watch_directory_problem(watch_dir)
        if problem is not None:
            logger.warning("%s", problem)
            return self
        patterns = self.instrument.file_patterns
        try:
            if self.instrument.run_detection.recursive:
                file_iter = (e for e in watch_dir.rglob("*") if e.is_file())
            else:
                file_iter = (e for e in watch_dir.iterdir() if e.is_file())
            has_match = any(
                fnmatch.fnmatch(entry.name, pat) for entry in file_iter for pat in patterns
            )
        except OSError as exc:
            logger.warning("Could not list watch directory %s: %s", watch_dir, exc)
            return self
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
    # Highest config revision for this watcher. Only `PUT /config` returns it,
    # and only on servers that store config revisions.
    config_revision: int | None = None


class HeartbeatResponse(BaseModel):
    model_config = _API_MODEL_CONFIG

    ok: bool
    # Latest config revision stored on the server for this watcher, or `None`
    # when there is none or the server predates remote config.
    config_revision: int | None = None


# ---------------------------------------------------------------------------
# Remote config revisions
# ---------------------------------------------------------------------------

# Matches the server's rule for an absolute `watch_directory`: a Windows drive
# path (`D:\...` or `D:/...`), a UNC path (`\\server\share`) or a POSIX path.
_ABSOLUTE_PATH_RE = re.compile(r"^(?:[A-Za-z]:[\\/]|\\\\|/)")


class RunDetectionSettings(BaseModel):
    model_config = _API_MODEL_CONFIG

    pattern: str
    recursive: bool

    @field_validator("pattern")
    @classmethod
    def _one_capture_group(cls, v: str) -> str:
        return check_run_pattern(v)


class WatcherConfigSettings(BaseModel):
    """The settings an admin can edit from the web app.

    Mirrors the server's `WatcherConfigSettings` (the wire contract) so both
    sides accept and reject the same values. Names match the YAML keys under
    `instrument:`.
    """

    model_config = _API_MODEL_CONFIG

    watch_directory: str = Field(min_length=1, max_length=1024)
    file_patterns: list[str] = Field(min_length=1, max_length=50)
    run_detection: RunDetectionSettings
    upload_mode: Literal["auto", "manual"]
    stability_period_seconds: int = Field(ge=1, le=300)
    max_stability_wait_seconds: int = Field(ge=1, le=86400)
    upload_parallelism: int = Field(ge=1, le=32)

    @field_validator("watch_directory")
    @classmethod
    def _absolute_path(cls, v: str) -> str:
        if not _ABSOLUTE_PATH_RE.match(v):
            raise ValueError(f"watch_directory must be an absolute path: {v!r}")
        return v

    @field_validator("file_patterns")
    @classmethod
    def _non_blank_patterns(cls, v: list[str]) -> list[str]:
        for pattern in v:
            if not pattern.strip():
                raise ValueError("file_patterns must not contain blank entries")
            if len(pattern) > 200:
                raise ValueError(f"file pattern is longer than 200 characters: {pattern[:40]}…")
        return v

    @model_validator(mode="after")
    def _max_wait_covers_stability_period(self) -> WatcherConfigSettings:
        if self.max_stability_wait_seconds < self.stability_period_seconds:
            raise ValueError(
                "max_stability_wait_seconds "
                f"({self.max_stability_wait_seconds}) must be >= "
                f"stability_period_seconds ({self.stability_period_seconds})"
            )
        return self


class ConfigRevisionResponse(BaseModel):
    """One stored config revision (`GET /watchers/{id}/config-revisions/latest`).

    `settings` stays a plain dict here so a revision with settings this watcher
    can't accept still parses, and the watcher can reject it with a reason
    instead of failing to read it.
    """

    model_config = _API_MODEL_CONFIG

    revision: int
    source: str
    status: str
    status_reason: str | None = None
    settings: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime | None = None
    resolved_at: datetime | None = None


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
    upload_type: str | None = None
    upload_id: str | None = None
    part_size: int | None = None
    part_count: int | None = None
    s3_bucket: str
    s3_key: str
    file_id: int
    expires_in: int | None = None
    already_uploaded: bool = False


class MultipartPartUrl(BaseModel):
    model_config = _API_MODEL_CONFIG

    part_number: int
    upload_url: str


class MultipartPartUrlsResponse(BaseModel):
    model_config = _API_MODEL_CONFIG

    expires_in: int
    parts: list[MultipartPartUrl]


class MultipartCompleteResponse(BaseModel):
    model_config = _API_MODEL_CONFIG

    file_id: int
    status: str
    already_uploaded: bool = False


class ApiErrorDetail(BaseModel):
    model_config = _API_MODEL_CONFIG

    code: str
    message: str
    details: dict | None = None


class WatcherUpdateInfoResponse(BaseModel):
    """Server-reported release metadata for the `data-hub-watcher` package.

    `latest_version` is `None` when the server has not been configured with a
    target version yet — clients should treat this as "no update info
    available" and skip the upgrade attempt rather than erroring out.
    """

    model_config = _API_MODEL_CONFIG

    latest_version: str | None = None
    min_supported_version: str | None = None
    mandatory: bool = False
