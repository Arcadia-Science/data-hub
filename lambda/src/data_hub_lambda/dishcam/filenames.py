"""Filename helpers for DishCam S3 gates and sibling lookup."""

from __future__ import annotations
import re

RUN_JSON_NAME = "run.json"
_TIFF_SUFFIXES = (".tif", ".tiff")
# A later `run.json` from another folder is stored as `run~<8 hex>.json`
# (16 hex if the short form was already taken). The extension stays `.json`
# so this check still recognizes it.
_RUN_JSON_RE = re.compile(r"^run(?:~[0-9a-f]{8}(?:[0-9a-f]{8})?)?\.json$", re.IGNORECASE)


def is_run_json(filename: str) -> bool:
    return _RUN_JSON_RE.fullmatch(filename) is not None


def is_tiff(filename: str) -> bool:
    return filename.lower().endswith(_TIFF_SUFFIXES)


def matches_filename(filename: str) -> bool:
    """S3 events for a stack or the sidecar can start encode.

    `run.json` therefore also passes the handler's union gate for every
    instrument type. The extra instrument lookup is cheap; the per-type
    gate still rejects it on non-DishCam instruments.
    """
    return is_tiff(filename) or is_run_json(filename)
