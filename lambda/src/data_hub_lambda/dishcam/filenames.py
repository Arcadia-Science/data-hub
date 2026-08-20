"""Filename helpers for DishCam S3 gates and sibling lookup."""

from __future__ import annotations

RUN_JSON_NAME = "run.json"
_TIFF_SUFFIXES = (".tif", ".tiff")


def is_run_json(filename: str) -> bool:
    return filename.lower() == RUN_JSON_NAME


def is_tiff(filename: str) -> bool:
    return filename.lower().endswith(_TIFF_SUFFIXES)


def matches_filename(filename: str) -> bool:
    """S3 events for a stack or the sidecar can start encode.

    `run.json` therefore also passes the handler's union gate for every
    instrument type. The extra instrument lookup is cheap; the per-type
    gate still rejects it on non-DishCam instruments.
    """
    return is_tiff(filename) or is_run_json(filename)
