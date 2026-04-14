from __future__ import annotations
from pathlib import Path

import pytest

from data_hub_lambda.spectramax_plate_reader.utils import parse_metadata

_FIXTURES_DIR = Path(__file__).resolve().parents[1] / "fixtures"

# Minimal SoftMax Pro plate header used by the synthetic-file helpers.
_BOILERPLATE_PREFIX = "Plate:\tPlate1\t1.3\tPlateFormat"
_BOILERPLATE_MIDDLE = "\tRaw\tFALSE\t1\t\t\t\t\t\t1"
_DATA_ROWS = "\tTemperature\t1\t2\n\t25.0\t0.123\t0.456\n~End\n"


def _build_xls(
    tmp_path: Path,
    *,
    measurement_type: str = "Endpoint",
    measurement_mode: str = "Absorbance",
    wavelength: str = "450",
    include_plate_line: bool = True,
) -> Path:
    """Write a minimal UTF-16 LE fixture file and return its path."""
    lines = ["##BLOCKS= 1\n"]
    if include_plate_line:
        header = (
            f"{_BOILERPLATE_PREFIX}\t{measurement_type}\t{measurement_mode}"
            f"{_BOILERPLATE_MIDDLE}\t{wavelength}\t1\t12\t96\t1\t4\n"
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
            "wavelength": "750 nm",
        }

    def test_well_scan_absorbance(self) -> None:
        result = parse_metadata(_FIXTURES_DIR / "spectramax_plate_reader_well_scan.xls")
        assert result == {
            "measurement_mode": "Absorbance",
            "measurement_type": "Well Scan",
            "wavelength": "595 nm",
        }

    def test_endpoint_sparse_absorbance(self) -> None:
        result = parse_metadata(_FIXTURES_DIR / "spectramax_plate_reader_endpoint_sparse.xls")
        assert result == {
            "measurement_mode": "Absorbance",
            "measurement_type": "Endpoint",
            "wavelength": "600 nm",
        }

    def test_kinetic_absorbance(self) -> None:
        result = parse_metadata(_FIXTURES_DIR / "spectramax_plate_reader_kinetic.xls")
        assert result == {
            "measurement_mode": "Absorbance",
            "measurement_type": "Kinetic",
            "wavelength": "595 nm",
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
            "wavelength": "750 nm",
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
            "wavelength": "488 nm",
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
        with pytest.raises(ValueError, match="Expected numeric wavelength"):
            parse_metadata(path)

    def test_missing_plate_header(self, tmp_path: Path) -> None:
        path = _build_xls(tmp_path, include_plate_line=False)
        with pytest.raises(ValueError, match="No 'Plate:' header line found"):
            parse_metadata(path)
