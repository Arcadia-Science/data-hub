from __future__ import annotations
from pathlib import Path

import pytest

from data_hub_lambda.spectramax_plate_reader.utils import (
    _parse_column_layout,
    parse_metadata,
)

_FIXTURES_DIR = Path(__file__).resolve().parents[1] / "fixtures"

# Minimal SoftMax Pro plate header used by the synthetic-file helpers.
#
# _build_xls assembles a header like:
#   {PREFIX}\t{type}\t{mode}{MIDDLE}\t{wavelength}\t1\t12\t96\t1\t4
#
# Full field layout (tab-separated, 0-indexed):
#   0  Plate:
#   1  Plate1          (_COL_PLATE_NAME)
#   2  1.3             (version)
#   3  PlateFormat     (format)
#   4  {type}          (_COL_MEASUREMENT_TYPE)
#   5  {mode}          (_COL_MEASUREMENT_MODE)
#   6  Raw             (anchor — _RAW_SEARCH_START)
#   7  FALSE           (+1)
#   8  1               (+2 = _OFF_NUM_READINGS)
#   9–13  (empty)
#  14  1
#  15  {wavelength}    (+9 = _OFF_WAVELENGTH)
#  16  1
#  17  12
#  18  96              (+12 = _OFF_NUM_WELLS)
#  19  1
#  20  4
_BOILERPLATE_PREFIX = "Plate:\tPlate1\t1.3\tPlateFormat"
_BOILERPLATE_MIDDLE_RAW = "\tRaw\tFALSE\t1\t\t\t\t\t\t1"
_BOILERPLATE_MIDDLE_REDUCED = "\tReduced\tFALSE\t1\t\t\t\t\t\t1"
_DATA_ROWS = "\tTemperature\t1\t2\n\t25.0\t0.123\t0.456\n~End\n"


def _build_xls(
    tmp_path: Path,
    *,
    measurement_type: str = "Endpoint",
    measurement_mode: str = "Absorbance",
    wavelength: str = "450",
    anchor: str = "Raw",
    include_plate_line: bool = True,
) -> Path:
    """Write a minimal UTF-16 LE fixture file and return its path."""
    middle = _BOILERPLATE_MIDDLE_REDUCED if anchor == "Reduced" else _BOILERPLATE_MIDDLE_RAW
    lines = ["##BLOCKS= 1\n"]
    if include_plate_line:
        header = (
            f"{_BOILERPLATE_PREFIX}\t{measurement_type}\t{measurement_mode}"
            f"{middle}\t{wavelength}\t1\t12\t96\t1\t4\n"
        )
        lines.append(header)
    lines.append(_DATA_ROWS)

    file_path = tmp_path / "test_plate.xls"
    file_path.write_text("".join(lines), encoding="utf-16")
    return file_path


# ---------------------------------------------------------------------------
# Real fixture tests
# ---------------------------------------------------------------------------


class TestRealFixtures:
    """Tests against real SpectraMax export files in the fixtures directory."""

    def test_endpoint_absorbance(self) -> None:
        result = parse_metadata(_FIXTURES_DIR / "spectramax_plate_reader_endpoint.xls")
        assert result == {
            "measurement_mode": "Absorbance",
            "measurement_type": "Endpoint",
            "wavelengths": ["750"],
        }

    def test_well_scan_absorbance(self) -> None:
        result = parse_metadata(_FIXTURES_DIR / "spectramax_plate_reader_well_scan.xls")
        assert result == {
            "measurement_mode": "Absorbance",
            "measurement_type": "Well Scan",
            "wavelengths": ["595"],
        }

    def test_endpoint_fluorescence(self) -> None:
        result = parse_metadata(_FIXTURES_DIR / "spectramax_plate_reader_fluorescence.xls")
        assert result == {
            "measurement_mode": "Fluorescence",
            "measurement_type": "Endpoint",
            "wavelengths": ["512"],
        }

    def test_endpoint_sparse_absorbance(self) -> None:
        result = parse_metadata(_FIXTURES_DIR / "spectramax_plate_reader_endpoint_sparse.xls")
        assert result == {
            "measurement_mode": "Absorbance",
            "measurement_type": "Endpoint",
            "wavelengths": ["600"],
        }

    def test_kinetic_absorbance(self) -> None:
        result = parse_metadata(_FIXTURES_DIR / "spectramax_plate_reader_kinetic.xls")
        assert result == {
            "measurement_mode": "Absorbance",
            "measurement_type": "Kinetic",
            "wavelengths": ["595"],
        }

    def test_kinetic_edge_wells_skipped(self) -> None:
        result = parse_metadata(
            _FIXTURES_DIR / "spectramax_plate_reader_kinetic_edge_wells_skipped.xls"
        )
        assert result == {
            "measurement_mode": "Absorbance",
            "measurement_type": "Kinetic",
            "wavelengths": ["595"],
        }

    def test_endpoint_flat(self) -> None:
        result = parse_metadata(_FIXTURES_DIR / "spectramax_plate_reader_endpoint_flat.xls")
        assert result == {
            "measurement_mode": "Absorbance",
            "measurement_type": "Endpoint",
            "wavelengths": ["595"],
        }


# ---------------------------------------------------------------------------
# Synthetic happy-path tests
# ---------------------------------------------------------------------------


class TestParseMetadataHappyPath:
    def test_absorbance_endpoint(self, tmp_path: Path) -> None:
        path = _build_xls(
            tmp_path,
            measurement_mode="Absorbance",
            measurement_type="Endpoint",
            wavelength="750",
        )
        result = parse_metadata(path)
        assert result == {
            "measurement_mode": "Absorbance",
            "measurement_type": "Endpoint",
            "wavelengths": ["750"],
        }

    def test_fluorescence_kinetic(self, tmp_path: Path) -> None:
        path = _build_xls(
            tmp_path,
            measurement_mode="Fluorescence",
            measurement_type="Kinetic",
            wavelength="488",
        )
        result = parse_metadata(path)
        assert result == {
            "measurement_mode": "Fluorescence",
            "measurement_type": "Kinetic",
            "wavelengths": ["488"],
        }

    def test_reduced_anchor(self, tmp_path: Path) -> None:
        path = _build_xls(
            tmp_path,
            measurement_mode="Absorbance",
            measurement_type="Endpoint",
            wavelength="600",
            anchor="Reduced",
        )
        result = parse_metadata(path)
        assert result == {
            "measurement_mode": "Absorbance",
            "measurement_type": "Endpoint",
            "wavelengths": ["600"],
        }


# ---------------------------------------------------------------------------
# Validation / error tests
# ---------------------------------------------------------------------------


class TestParseMetadataValidation:
    def test_invalid_measurement_mode(self, tmp_path: Path) -> None:
        path = _build_xls(tmp_path, measurement_mode="Luminescence")
        with pytest.raises(ValueError, match="Unexpected measurement mode 'Luminescence'"):
            parse_metadata(path)

    def test_invalid_measurement_type(self, tmp_path: Path) -> None:
        path = _build_xls(tmp_path, measurement_type="Spectrum")
        with pytest.raises(ValueError, match="Unexpected measurement type 'Spectrum'"):
            parse_metadata(path)

    def test_non_numeric_wavelength(self, tmp_path: Path) -> None:
        path = _build_xls(tmp_path, wavelength="ABC")
        with pytest.raises(ValueError, match="Expected space-separated numeric wavelengths"):
            parse_metadata(path)

    def test_dual_wavelength(self, tmp_path: Path) -> None:
        path = _build_xls(tmp_path, wavelength="750 600")
        result = parse_metadata(path)
        assert result == {
            "measurement_mode": "Absorbance",
            "measurement_type": "Endpoint",
            "wavelengths": ["750", "600"],
        }

    def test_four_wavelengths(self, tmp_path: Path) -> None:
        path = _build_xls(tmp_path, wavelength="750 700 650 600")
        result = parse_metadata(path)
        assert result == {
            "measurement_mode": "Absorbance",
            "measurement_type": "Endpoint",
            "wavelengths": ["750", "700", "650", "600"],
        }

    def test_missing_plate_header(self, tmp_path: Path) -> None:
        path = _build_xls(tmp_path, include_plate_line=False)
        with pytest.raises(ValueError, match="No 'Plate:' header line found"):
            parse_metadata(path)

    def test_missing_anchor_token(self, tmp_path: Path) -> None:
        """Plate header with no recognised anchor token raises a clear ValueError."""
        header = "Plate:\tPlate1\t1.3\tPlateFormat\tEndpoint\tAbsorbance\tNOT_RAW\n"
        content = f"##BLOCKS= 1\n{header}{_DATA_ROWS}"
        path = tmp_path / "no_raw.xls"
        path.write_text(content, encoding="utf-16")
        with pytest.raises(ValueError, match="No anchor token"):
            parse_metadata(path)

    def test_column_header_with_no_recognizable_labels(self) -> None:
        """Column header row lacking numeric or well-position labels raises ValueError."""
        with pytest.raises(ValueError, match="Could not determine column layout"):
            _parse_column_layout("\tTemperature\tA\tB")
