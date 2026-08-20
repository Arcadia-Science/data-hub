"""Filename helpers for DishCam S3 gates and sibling lookup."""

from __future__ import annotations

RUN_JSON_NAME = "run.json"
_TIFF_SUFFIXES = (".tif", ".tiff")


def is_run_json(filename: str) -> bool:
    return filename.lower() == RUN_JSON_NAME


def is_tiff(filename: str) -> bool:
    return filename.lower().endswith(_TIFF_SUFFIXES)


def matches_filename(filename: str) -> bool:
    """S3 events for either the stack or the sidecar can start encode."""
    return is_tiff(filename) or is_run_json(filename)
