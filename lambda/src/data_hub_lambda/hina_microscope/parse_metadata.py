from __future__ import annotations
from typing import Any

from arcadia_microscopy_tools import MicroscopyImage
from arcadia_microscopy_tools.channels import Channel
from arcadia_microscopy_tools.metadata_structures import DimensionFlags


def parse_metadata(image: MicroscopyImage) -> dict[str, Any]:
    """Extract run-level metadata from a loaded Nikon ND2 image.

    Returns a JSON-serializable dict with three keys:

    - `sizes`: the full dimension map, e.g. `{"C": 4, "Y": 256, "X": 256}`.
    - `channels`: a list of `{name, excitation_nm, emission_nm, color}` dicts.
    - `dimensions`: a list of `DimensionFlags` member names set on the image.

    The function operates on the already-loaded `MicroscopyImage` so the
    caller does not need to re-open the ND2 file for the metadata step.
    """
    return {
        "sizes": dict(image.sizes),
        "channels": [_channel_to_dict(channel) for channel in image.channels],
        "dimensions": _dimension_names(image.dimensions),
    }


def _channel_to_dict(channel: Channel) -> dict[str, Any]:
    color = channel.color.lower()
    return {
        "name": channel.name,
        "excitation_nm": channel.excitation_nm,
        "emission_nm": channel.emission_nm,
        "color": color,
    }


def _dimension_names(dimensions: DimensionFlags) -> list[str]:
    """Serialize a `DimensionFlags` IntFlag as a list of member names."""
    return [flag.name for flag in DimensionFlags if flag in dimensions and flag.name]
