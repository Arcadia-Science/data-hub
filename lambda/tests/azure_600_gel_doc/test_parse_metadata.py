from __future__ import annotations
import struct
from pathlib import Path

import pytest
import tifffile

from data_hub_lambda.azure_600_gel_doc.parse_metadata import (
    _extract_string_records,
    _find_channel_boundary,
    _read_xp_comment,
    parse_metadata,
)

_FIXTURES_DIR = Path(__file__).resolve().parents[1] / "fixtures"
_HAS_TRUE_COLOR_FIXTURE = (_FIXTURES_DIR / "azure_600_gel_doc_true_color.tif").exists()


# ---------------------------------------------------------------------------
# Real fixture tests
# ---------------------------------------------------------------------------


class TestRealFixture:
    """Tests against the real Azure 600 TIFF in the fixtures directory."""

    def test_parse_metadata_chemiluminescence(self) -> None:
        result = parse_metadata(_FIXTURES_DIR / "azure_600_gel_doc_example.tif")
        assert result == {
            "capture_type": "Manual",
            "imaging_mode": "Chemiluminescence",
            "wavelengths": [],
            "colors": [],
        }

    def test_capture_type(self) -> None:
        result = parse_metadata(_FIXTURES_DIR / "azure_600_gel_doc_example.tif")
        assert result["capture_type"] == "Manual"

    def test_imaging_mode(self) -> None:
        result = parse_metadata(_FIXTURES_DIR / "azure_600_gel_doc_example.tif")
        assert result["imaging_mode"] == "Chemiluminescence"

    def test_no_wavelengths_for_chemi(self) -> None:
        result = parse_metadata(_FIXTURES_DIR / "azure_600_gel_doc_example.tif")
        assert result["wavelengths"] == []

    def test_no_colors_for_chemi(self) -> None:
        result = parse_metadata(_FIXTURES_DIR / "azure_600_gel_doc_example.tif")
        assert result["colors"] == []


@pytest.mark.skipif(not _HAS_TRUE_COLOR_FIXTURE, reason="true-color fixture not available")
class TestTrueColorFixture:
    """Tests against a True Color Imaging TIFF in the fixtures directory."""

    def test_parse_metadata_true_color(self) -> None:
        result = parse_metadata(_FIXTURES_DIR / "azure_600_gel_doc_true_color.tif")
        assert result == {
            "capture_type": "Auto Image",
            "imaging_mode": "True Color Imaging",
            "wavelengths": ["628", "524", "472"],
            "colors": ["Red", "Green", "Blue"],
        }

    def test_imaging_mode(self) -> None:
        result = parse_metadata(_FIXTURES_DIR / "azure_600_gel_doc_true_color.tif")
        assert result["imaging_mode"] == "True Color Imaging"

    def test_wavelengths(self) -> None:
        result = parse_metadata(_FIXTURES_DIR / "azure_600_gel_doc_true_color.tif")
        assert result["wavelengths"] == ["628", "524", "472"]

    def test_colors(self) -> None:
        result = parse_metadata(_FIXTURES_DIR / "azure_600_gel_doc_true_color.tif")
        assert result["colors"] == ["Red", "Green", "Blue"]


# ---------------------------------------------------------------------------
# Low-level extraction tests
# ---------------------------------------------------------------------------


class TestReadXpComment:
    def test_reads_bytes(self) -> None:
        raw = _read_xp_comment(_FIXTURES_DIR / "azure_600_gel_doc_example.tif")
        assert isinstance(raw, bytes)
        assert len(raw) > 0

    def test_contains_imaging_system_marker(self) -> None:
        raw = _read_xp_comment(_FIXTURES_DIR / "azure_600_gel_doc_example.tif")
        assert b"Azure.Image.Processing.ImageInfo" in raw

    def test_missing_tag_raises(self, tmp_path: Path) -> None:
        tif_path = tmp_path / "empty.tif"
        tifffile.imwrite(str(tif_path), data=[[0, 0], [0, 0]])
        with pytest.raises(ValueError, match="no XPComment"):
            _read_xp_comment(tif_path)


class TestExtractStringRecords:
    def test_finds_known_strings(self) -> None:
        raw = _read_xp_comment(_FIXTURES_DIR / "azure_600_gel_doc_example.tif")
        strings = _extract_string_records(raw)
        values = [s for s, _ in strings]
        assert "Chemi Blot" in values
        assert "Manually Image" in values
        assert "Chemiluminescence" in values

    def test_preserves_offset_ordering(self) -> None:
        raw = _read_xp_comment(_FIXTURES_DIR / "azure_600_gel_doc_example.tif")
        strings = _extract_string_records(raw)
        offsets = [off for _, off in strings]
        assert offsets == sorted(offsets)


class TestFindChannelBoundary:
    def test_boundary_separates_regions(self) -> None:
        raw = _read_xp_comment(_FIXTURES_DIR / "azure_600_gel_doc_example.tif")
        boundary = _find_channel_boundary(raw)
        all_strings = _extract_string_records(raw)
        value_strings = [(s, off) for s, off in all_strings if "Azure.Image.Processing" not in s]

        info = [s for s, off in value_strings if off < boundary]
        chan = [s for s, off in value_strings if off >= boundary]

        assert "Manually Image" in info
        assert "Chemiluminescence" in chan


# ---------------------------------------------------------------------------
# Synthetic BinaryObjectString tests
# ---------------------------------------------------------------------------


def _make_string_record(obj_id: int, value: str) -> bytes:
    """Build a single .NET BinaryObjectString record (type 0x06)."""
    encoded = value.encode("utf-8")
    length_byte = struct.pack("B", len(encoded))
    return b"\x06" + struct.pack("<I", obj_id) + length_byte + encoded


class TestExtractStringRecordsSynthetic:
    def test_single_record(self) -> None:
        data = b"\x00\x00" + _make_string_record(1, "hello") + b"\x00\x00"
        result = _extract_string_records(data)
        assert len(result) == 1
        assert result[0][0] == "hello"

    def test_multiple_records(self) -> None:
        data = _make_string_record(1, "alpha") + b"\xff\xff" + _make_string_record(2, "beta")
        result = _extract_string_records(data)
        values = [s for s, _ in result]
        assert "alpha" in values
        assert "beta" in values

    def test_skips_non_printable(self) -> None:
        record = b"\x06" + struct.pack("<I", 1) + b"\x03\x00\x01\x02"
        data = b"\x00" + record + b"\x00"
        result = _extract_string_records(data)
        assert len(result) == 0
