from __future__ import annotations
from types import SimpleNamespace
from typing import cast

import pytest
from arcadia_microscopy_tools import MicroscopyImage
from arcadia_microscopy_tools.channels import BRIGHTFIELD, DAPI, FITC
from arcadia_microscopy_tools.metadata_structures import DimensionFlags

from data_hub_lambda.hina_microscope.parse_metadata import (
    _channel_to_dict,
    _dimension_names,
    parse_metadata,
)


def _make_image(
    sizes: dict[str, int],
    channels: list,
    dimensions: DimensionFlags,
) -> MicroscopyImage:
    """Build a minimal MicroscopyImage-shaped stub for metadata tests."""
    return cast(
        MicroscopyImage,
        SimpleNamespace(sizes=sizes, channels=channels, dimensions=dimensions),
    )


class TestParseMetadata:
    def test_returns_expected_keys(self) -> None:
        image = _make_image({"C": 1, "Y": 2, "X": 2}, [DAPI], DimensionFlags(0))

        result = parse_metadata(image)

        assert set(result.keys()) == {"sizes", "channels", "dimensions"}

    def test_preserves_sizes_mapping(self) -> None:
        image = _make_image({"C": 4, "Y": 256, "X": 256}, [DAPI, FITC], DimensionFlags(0))

        result = parse_metadata(image)

        assert result["sizes"] == {"C": 4, "Y": 256, "X": 256}

    def test_channels_serialized_as_dicts(self) -> None:
        image = _make_image(
            {"C": 3, "Y": 8, "X": 8},
            [BRIGHTFIELD, DAPI, FITC],
            DimensionFlags.MULTICHANNEL,
        )

        result = parse_metadata(image)

        assert result["channels"] == [
            {
                "name": "BRIGHTFIELD",
                "excitation_nm": None,
                "emission_nm": None,
                "color": "#ffffff",
            },
            {
                "name": "DAPI",
                "excitation_nm": 405,
                "emission_nm": 450,
                "color": "#0033ff",
            },
            {
                "name": "FITC",
                "excitation_nm": 488,
                "emission_nm": 512,
                "color": "#07ff00",
            },
        ]

    def test_dimensions_serialized_as_names(self) -> None:
        image = _make_image(
            {"C": 2, "Z": 5, "Y": 8, "X": 8},
            [DAPI, FITC],
            DimensionFlags.MULTICHANNEL | DimensionFlags.Z_STACK,
        )

        result = parse_metadata(image)

        assert sorted(result["dimensions"]) == ["MULTICHANNEL", "Z_STACK"]

    def test_empty_dimensions_serializes_to_empty_list(self) -> None:
        image = _make_image({"C": 1, "Y": 8, "X": 8}, [DAPI], DimensionFlags(0))

        result = parse_metadata(image)

        assert result["dimensions"] == []

    def test_result_is_json_serializable(self) -> None:
        import json

        image = _make_image(
            {"C": 2, "T": 10, "Y": 32, "X": 32},
            [DAPI, FITC],
            DimensionFlags.MULTICHANNEL | DimensionFlags.TIMELAPSE,
        )

        result = parse_metadata(image)

        # Round-trip through JSON to verify everything is serializable.
        round_tripped = json.loads(json.dumps(result))
        assert round_tripped == result


class TestChannelToDict:
    def test_channel_with_all_fields(self) -> None:
        result = _channel_to_dict(DAPI)
        assert result == {
            "name": "DAPI",
            "excitation_nm": 405,
            "emission_nm": 450,
            "color": "#0033ff",
        }

    def test_channel_without_wavelengths(self) -> None:
        result = _channel_to_dict(BRIGHTFIELD)
        assert result["excitation_nm"] is None
        assert result["emission_nm"] is None
        assert result["color"] == "#ffffff"

    def test_channel_color_normalized_to_lowercase(self) -> None:
        from arcadia_microscopy_tools.channels import Channel

        custom = Channel(name="CUSTOM", excitation_nm=500, emission_nm=520, color="#AABBCC")

        result = _channel_to_dict(custom)

        assert result == {
            "name": "CUSTOM",
            "excitation_nm": 500,
            "emission_nm": 520,
            "color": "#aabbcc",
        }


class TestDimensionNames:
    def test_single_flag(self) -> None:
        assert _dimension_names(DimensionFlags.MULTICHANNEL) == ["MULTICHANNEL"]

    def test_combined_flags_preserves_all_members(self) -> None:
        combined = DimensionFlags.MULTICHANNEL | DimensionFlags.Z_STACK | DimensionFlags.TIMELAPSE

        result = _dimension_names(combined)

        assert set(result) == {"MULTICHANNEL", "Z_STACK", "TIMELAPSE"}

    def test_no_flags(self) -> None:
        assert _dimension_names(DimensionFlags(0)) == []


@pytest.fixture(autouse=True)
def _no_warnings_leak():
    """Keep tests quiet regardless of upstream deprecation warnings."""
    import warnings

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        yield
