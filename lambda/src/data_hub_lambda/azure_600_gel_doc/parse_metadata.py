"""Parse imaging metadata from Azure 600 Gel Doc TIFF files.

The Azure 600 stores instrument metadata in the TIFF ``XPComment`` tag
(tag 40092) as a .NET ``BinaryFormatter``-serialized ``ImageInfo`` object.
This module extracts the key fields by scanning for ``BinaryObjectString``
records (type ``0x06``) in the serialized byte stream and mapping them to
the known class field structure.

Extracted fields:
  - **capture_type** — ``"Auto Image"`` or ``"Manual"``.
  - **imaging_mode** — ``"True Color Imaging"``, ``"Fluorescence"``, or
    ``"Chemiluminescence"``.
  - **wavelengths** — list of excitation wavelength strings (e.g.
    ``["628", "524", "472"]``). Empty for chemiluminescence.
  - **colors** — list of color-channel names (e.g.
    ``["Red", "Green", "Blue"]``). Empty for chemiluminescence.
"""

from __future__ import annotations
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

_COLOR_NAMES = {"Red", "Green", "Blue", "Cyan", "Magenta", "Yellow"}


def parse_metadata(file_path: Path) -> dict[str, Any]:
    """Extract imaging metadata from an Azure 600 Gel Doc TIFF.

    Returns:
        A dict with keys ``capture_type``, ``imaging_mode``,
        ``wavelengths``, and ``colors``.

    Raises:
        ValueError: If the file lacks the expected ``XPComment`` tag.
    """
    raw = _read_xp_comment(file_path)
    all_strings = _extract_string_records(raw)

    value_strings = [(s, off) for s, off in all_strings if "Azure.Image.Processing" not in s]

    boundary = _find_channel_boundary(raw)
    info_strings = [s for s, off in value_strings if off < boundary]
    channel_strings = [s for s, off in value_strings if off >= boundary]

    capture_type = _parse_capture_type(info_strings)
    channels = _group_channel_strings(channel_strings)
    imaging_mode = _derive_imaging_mode(channels)
    wavelengths = _extract_wavelengths(channels)
    colors = _extract_colors(channels)

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
    """Find all ``BinaryObjectString`` records (type ``0x06``) in the stream.

    Returns a list of ``(decoded_string, byte_offset)`` sorted by offset.
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
    """Return the byte offset where the ``ImageChannel`` class definition begins.

    All string records *before* this offset belong to the top-level
    ``ImageInfo`` object; records *at or after* it belong to channel objects.
    """
    idx = data.find(_CHANNEL_CLASS_NAME + b"\x16\x00\x00\x00")
    if idx < 0:
        idx = data.find(_CHANNEL_CLASS_NAME)
    return idx if idx >= 0 else len(data)


def _parse_capture_type(info_strings: list[str]) -> str | None:
    """Find and normalize the ``CaptureType`` value from ImageInfo strings."""
    for s in info_strings:
        if s in _CAPTURE_TYPE_LABELS:
            return _CAPTURE_TYPE_LABELS[s]
    return None


def _group_channel_strings(channel_strings: list[str]) -> list[dict[str, str]]:
    """Group channel string records into per-channel dicts.

    Each active ``ImageChannel`` produces exactly four consecutive string
    records: ``DyeName``, ``ExcitationName``, ``EmissionName``, ``ExposureType``.
    Inactive channels are serialized with null markers and produce no string
    records.
    """
    channels: list[dict[str, str]] = []
    for i in range(0, len(channel_strings) - 3, 4):
        channels.append(
            {
                "dye_name": channel_strings[i],
                "excitation": channel_strings[i + 1],
                "emission": channel_strings[i + 2],
                "exposure_type": channel_strings[i + 3],
            }
        )
    return channels


def _derive_imaging_mode(channels: list[dict[str, str]]) -> str | None:
    """Determine the imaging mode from the active channel dye names."""
    dye_names = {ch["dye_name"] for ch in channels}

    if "Chemiluminescence" in dye_names:
        return "Chemiluminescence"

    if dye_names >= {"Red", "Green", "Blue"}:
        return "True Color Imaging"

    if channels:
        return "Fluorescence"

    return None


def _extract_wavelengths(channels: list[dict[str, str]]) -> list[str]:
    """Return excitation wavelength values (numeric strings only)."""
    return [ch["excitation"] for ch in channels if ch["excitation"].isdigit()]


def _extract_colors(channels: list[dict[str, str]]) -> list[str]:
    """Return color names from channels whose ``DyeName`` is a known color."""
    return [ch["dye_name"] for ch in channels if ch["dye_name"] in _COLOR_NAMES]
