"""Parse Azure Cielo native `.AZE` project files into melt-curve blocks.

Reverse-engineered container (no vendor spec exists): a sequence of big-endian
u32 length-prefixed segments — magic string, metadata JSON, a fixed-size binary
protocol block, plate-layout JSON, analysis-settings JSON, a data segment, and
a crosstalk JSON list. The data segment nests its own binary header (`Azure
Data` magic) ahead of pretty-printed JSON and zero padding. Melt curves are
flat well-major `MeltCurveChannelN` arrays over the shared `MeltCurveTemper`
axis in centidegrees C. Setup-only files carry an empty data segment.
"""

from __future__ import annotations
import json
import re
import struct
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from data_hub_lambda.azure_cielo_qpcr.melting_curve import ChannelBlock

_MAGIC = b"Azure qPCR Project"
_METADATA_INDEX = 1
_PLATE_INDEX = 3
_DATA_INDEX = 5

# The instrument software also exports the data segment on its own, without
# the project wrapper; such files open with the nested segment's magic.
_DATA_MAGIC = b"Azure Data\x00"
_BARE_DATA_PREFIX = struct.pack(">I", len(_DATA_MAGIC)) + _DATA_MAGIC

_MELT_CHANNEL_RE = re.compile(r"^MeltCurveChannel(\d+)$")
_MELT_TEMPER_KEY = "MeltCurveTemper"
_EXPOSURE_RE = re.compile(r"^Channel (\d)expose time$")

# The data JSON's instrument keys carry a trailing colon in the vendor output.
_INSTRUMENT_KEYS = {
    "Device id:": "device_id",
    "Device name:": "device_name",
    "Instrument software Version:": "instrument_software_version",
    "Instrument control module software Version:": "control_module_software_version",
    "Instrument heater module software Version:": "heater_module_software_version",
    "Program:": "program",
    "Workspace:": "workspace",
    "Gain:": "gain",
    "Run start time:": "run_start_time",
    "Run end time:": "run_end_time",
    "Experiment Start Time:": "experiment_start_time",
    "Experiment End Time:": "experiment_end_time",
}

_WELL_GRID_COLS = {96: 12, 384: 24}


@dataclass
class ParsedAze:
    metadata: dict[str, Any]
    instrument: dict[str, Any]
    blocks: list[ChannelBlock] = field(default_factory=list)


def is_aze_filename(filename: str) -> bool:
    return filename.lower().endswith(".aze")


def parse_aze_file(path: Path) -> ParsedAze:
    data = path.read_bytes()
    if data.startswith(_BARE_DATA_PREFIX):
        # Bare data-segment export: no metadata or plate layout travels with
        # it, so wells get row-major labels from the standard grid.
        data_obj = _parse_data_segment(data)
        return ParsedAze(
            metadata={},
            instrument=_instrument_info(data_obj),
            blocks=_channel_blocks(data_obj, {}),
        )
    if not data.startswith(struct.pack(">I", len(_MAGIC)) + _MAGIC):
        raise ValueError(f"Not an Azure Cielo .AZE project file: {path}")
    segments = _iter_segments(data)
    if len(segments) <= _METADATA_INDEX:
        raise ValueError(f"Not an Azure Cielo .AZE project file: {path}")
    metadata = json.loads(segments[_METADATA_INDEX])
    # Pre-run saves stop after the plate layout or analysis segment, so the
    # data segment is absent rather than empty. Both mean "no melt data".
    plate_raw = segments[_PLATE_INDEX] if len(segments) > _PLATE_INDEX else b"{}"
    data_raw = segments[_DATA_INDEX] if len(segments) > _DATA_INDEX else b""
    data_obj = _parse_data_segment(data_raw)
    return ParsedAze(
        metadata=metadata,
        instrument=_instrument_info(data_obj),
        blocks=_channel_blocks(data_obj, json.loads(plate_raw)),
    )


def _iter_segments(data: bytes) -> list[bytes]:
    segments: list[bytes] = []
    offset = 0
    while offset + 4 <= len(data):
        (length,) = struct.unpack_from(">I", data, offset)
        offset += 4
        if length > len(data) - offset:
            raise ValueError("Truncated .AZE: segment length exceeds remaining bytes")
        segments.append(data[offset : offset + length])
        offset += length
    if offset != len(data):
        raise ValueError("Truncated .AZE: trailing bytes after last segment")
    return segments


def _parse_data_segment(payload: bytes) -> dict[str, Any]:
    if not payload:
        return {}
    start = payload.find(b"{")
    if start < 0:
        raise ValueError(".AZE data segment has no JSON payload")
    # latin-1 maps bytes 1:1, so the binary tail after the JSON stays decodable
    # and raw_decode can stop at the closing brace.
    obj, _ = json.JSONDecoder().raw_decode(payload[start:].decode("latin-1"))
    return obj


def _channel_blocks(data_obj: dict[str, Any], plate: dict[str, Any]) -> list[ChannelBlock]:
    channel_keys = sorted(
        (int(m.group(1)), key) for key in data_obj if (m := _MELT_CHANNEL_RE.match(key))
    )
    if not channel_keys:
        return []
    temper = data_obj.get(_MELT_TEMPER_KEY)
    if not isinstance(temper, list) or not temper:
        raise ValueError(".AZE melt data is missing the MeltCurveTemper axis")
    temps_c = [t / 100.0 for t in temper]
    points = len(temps_c)

    blocks: list[ChannelBlock] = []
    for _, key in channel_keys:
        values = data_obj[key]
        if len(values) % points != 0:
            raise ValueError(
                f".AZE {key} has {len(values)} values, not a multiple of {points} melt points"
            )
        names = _well_names(plate, len(values) // points)
        block = ChannelBlock(channel=key.removeprefix("MeltCurve"))
        for well_index, name in enumerate(names):
            start = well_index * points
            block.wells[name] = [(temps_c[i], float(values[start + i])) for i in range(points)]
        blocks.append(block)
    return blocks


def _well_names(plate: dict[str, Any], well_count: int) -> list[str]:
    """Well labels in flat-array order.

    The plate layout's `Pos.Id` is the vendor's own row-major flat index, so
    prefer it; fall back to computed labels for standard plate geometries.
    """
    well_infos = plate.get("WellInfos")
    if isinstance(well_infos, list):
        flat = [w for row in well_infos if isinstance(row, list) for w in row]
        if len(flat) == well_count:
            try:
                ordered = sorted(flat, key=lambda w: w["Pos"]["Id"])
                return [str(w["Id"]["Name"]) for w in ordered]
            except (KeyError, TypeError):
                pass
    cols = _WELL_GRID_COLS.get(well_count)
    if cols is None:
        raise ValueError(f"Unsupported .AZE well count: {well_count}")
    return [f"{chr(ord('A') + i // cols)}{i % cols + 1}" for i in range(well_count)]


def _instrument_info(data_obj: dict[str, Any]) -> dict[str, Any]:
    info = {
        out_key: data_obj[raw_key]
        for raw_key, out_key in _INSTRUMENT_KEYS.items()
        if raw_key in data_obj
    }
    exposures = {
        f"channel_{m.group(1)}": value
        for key, value in data_obj.items()
        if (m := _EXPOSURE_RE.match(key))
    }
    if exposures:
        info["channel_exposure_times"] = exposures
    return info
