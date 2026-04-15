"""Parse imaging metadata from Azure 600 Gel Doc TIFF files.

The Azure 600 stores instrument metadata in the TIFF `XPComment` tag
(tag 40092) as a .NET `BinaryFormatter`-serialized `ImageInfo` object.
This module extracts the key fields by scanning for `BinaryObjectString`
records (type `0x06`) in the serialized byte stream and mapping them to
the known class field structure.

Extracted fields:
  - **capture_type** — `"Auto Image"` or `"Manual"`.
  - **imaging_mode** — `"True Color Imaging"`, `"Fluorescence"`, or
    `"Chemiluminescence"`.
  - **wavelengths** — list of excitation wavelength strings (e.g.
    `["628", "524", "472"]`). Empty for chemiluminescence.
  - **colors** — list of color-channel names (e.g.
    `["Red", "Green", "Blue"]`). Empty for chemiluminescence.
"""

from __future__ import annotations
import re
import struct
from pathlib import Path
from typing import Any

import tifffile

_XP_COMMENT_TAG = 40092

_CHANNEL_CLASS_NAME = b"Azure.Image.Processing.ImageChannel"

_CAPTURE_TYPE_LABELS: dict[str, str] = {
    "Auto Image": "Auto Image",
    "Manually Image": "Manual",
}

_COLOR_NAMES = {"Red", "Green", "Blue", "Cyan", "Magenta", "Yellow", "Orange", "FarRed"}

_COLOR_DISPLAY_NAMES: dict[str, str] = {
    "FarRed": "Far Red",
}

_KNOWN_IMAGING_MODES = {"True Color Imaging", "Fluorescence", "Chemiluminescence"}

_WAVELENGTH_RE = re.compile(r"(\d+)\s*nm")
_PAREN_COLOR_RE = re.compile(r"\((\w+)\s+\w+\)")


def parse_metadata(file_path: Path) -> dict[str, Any]:
    """Extract imaging metadata from an Azure 600 Gel Doc TIFF.

    Returns:
        A dict with keys `capture_type`, `imaging_mode`,
        `wavelengths`, and `colors`.

    Raises:
        ValueError: If the file lacks the expected `XPComment` tag.
    """
    raw = _read_xp_comment(file_path)
    all_strings = _extract_string_records(raw)

    value_strings = [(s, off) for s, off in all_strings if "Azure.Image.Processing" not in s]

    boundary = _find_channel_boundary(raw)
    info_strings = [s for s, off in value_strings if off < boundary]
    channel_strings = [s for s, off in value_strings if off >= boundary]

    capture_type = _parse_capture_type(info_strings)
    imaging_mode = _derive_imaging_mode(info_strings, channel_strings)
    wavelengths = _extract_wavelengths(channel_strings)
    colors = _extract_colors(channel_strings)

    return {
        "capture_type": capture_type,
        "imaging_mode": imaging_mode,
        "wavelengths": wavelengths,
        "colors": colors,
    }


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _read_xp_comment(file_path: Path) -> bytes:
    with tifffile.TiffFile(file_path) as tif:
        page = tif.pages.first
        if _XP_COMMENT_TAG not in page.tags:
            raise ValueError(f"TIFF file has no XPComment metadata tag: {file_path}")
        return page.tags[_XP_COMMENT_TAG].value  # type: ignore[no-any-return]


def _read_leb128(data: bytes, offset: int) -> tuple[int, int]:
    """Read a LEB128-encoded unsigned integer (used for .NET string lengths)."""
    result = 0
    shift = 0
    while True:
        byte = data[offset]
        result |= (byte & 0x7F) << shift
        offset += 1
        if not (byte & 0x80):
            break
        shift += 7
    return result, offset


def _extract_string_records(data: bytes) -> list[tuple[str, int]]:
    """Find all `BinaryObjectString` records (type `0x06`) in the stream.

    Returns a list of `(decoded_string, byte_offset)` sorted by offset.
    """
    results: list[tuple[str, int]] = []
    i = 0
    while i < len(data) - 5:
        if data[i] == 0x06:
            try:
                struct.unpack_from("<I", data, i + 1)
                str_len, str_start = _read_leb128(data, i + 5)
                if 0 < str_len < 500 and str_start + str_len <= len(data):
                    s = data[str_start : str_start + str_len].decode("utf-8")
                    if all(c.isprintable() or c in "\n\r\t" for c in s):
                        results.append((s, i))
            except (UnicodeDecodeError, struct.error):
                pass
        i += 1
    return results


def _find_channel_boundary(data: bytes) -> int:
    """Return the byte offset where the `ImageChannel` class definition begins.

    All string records *before* this offset belong to the top-level
    `ImageInfo` object; records *at or after* it belong to channel objects.
    """
    idx = data.find(_CHANNEL_CLASS_NAME + b"\x16\x00\x00\x00")
    if idx < 0:
        idx = data.find(_CHANNEL_CLASS_NAME)
    return idx if idx >= 0 else len(data)


def _parse_capture_type(info_strings: list[str]) -> str | None:
    """Find and normalize the `CaptureType` value from ImageInfo strings."""
    for s in info_strings:
        if s in _CAPTURE_TYPE_LABELS:
            return _CAPTURE_TYPE_LABELS[s]
    return None


def _derive_imaging_mode(info_strings: list[str], channel_strings: list[str]) -> str | None:
    """Determine the imaging mode from info-level and channel-level strings.

    Checks the top-level ``ImageInfo`` strings first (where modes like
    ``"True Color Imaging"`` are stored explicitly), then falls back to
    heuristics based on the channel string records.
    """
    for s in info_strings:
        if s in _KNOWN_IMAGING_MODES:
            return s

    if "Chemiluminescence" in channel_strings:
        return "Chemiluminescence"

    if {"Red", "Green", "Blue"} <= set(channel_strings):
        return "True Color Imaging"

    if channel_strings:
        return "Fluorescence"

    return None


def _extract_wavelengths(channel_strings: list[str]) -> list[str]:
    """Return excitation wavelength values from channel strings.

    Handles both plain numeric strings (``"628"``) and descriptive labels
    (``"628nm (Red LED)"``).
    """
    wavelengths: list[str] = []
    for s in channel_strings:
        if s.isdigit():
            wavelengths.append(s)
            continue
        m = _WAVELENGTH_RE.search(s)
        if m:
            wavelengths.append(m.group(1))
    return wavelengths


def _extract_colors(channel_strings: list[str]) -> list[str]:
    """Return color names from channel strings.

    Handles plain color names (``"Red"``), LED labels (``"628nm (Red LED)"``),
    and emission-filter labels (``"595nm (Orange EM)"``).
    """
    colors: list[str] = []
    seen: set[str] = set()
    for s in channel_strings:
        color: str | None = None
        if s in _COLOR_NAMES:
            color = s
        else:
            m = _PAREN_COLOR_RE.search(s)
            if m and m.group(1) in _COLOR_NAMES:
                color = m.group(1)
        if color and color not in seen:
            colors.append(_COLOR_DISPLAY_NAMES.get(color, color))
            seen.add(color)
    return colors
