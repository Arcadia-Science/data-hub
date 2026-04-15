from __future__ import annotations
from pathlib import Path

import pytest

from data_hub_lambda.spectramax_plate_reader.utils import parse_raw_well_data

_FIXTURES_DIR = Path(__file__).resolve().parents[1] / "fixtures"

_EXPECTED_COLUMNS = [
    "time",
    "plate_name",
    "well_position",
    "temperature_c",
    "value",
    "row_label",
    "column_label",
    "wavelength",
]


# ---------------------------------------------------------------------------
# Real fixture tests
# ---------------------------------------------------------------------------


class TestEndpoint:
    """Endpoint / Absorbance / 750 nm, single plate, rows A–D populated."""

    @pytest.fixture(autouse=True)
    def _load(self) -> None:
        self.df = parse_raw_well_data(_FIXTURES_DIR / "spectramax_plate_reader_endpoint.xls")

    def test_columns(self) -> None:
        assert list(self.df.columns) == _EXPECTED_COLUMNS

    def test_shape(self) -> None:
        assert self.df.shape == (48, 8)  # 4 rows × 12 cols

    def test_plate_name(self) -> None:
        assert self.df["plate_name"].unique().tolist() == ["Plate2"]

    def test_time_is_null(self) -> None:
        assert bool(self.df["time"].isna().all())

    def test_wavelength(self) -> None:
        assert (self.df["wavelength"] == 750).all()

    def test_temperature(self) -> None:
        assert (self.df["temperature_c"] == 21.5).all()

    def test_first_well(self) -> None:
        first = self.df.iloc[0]
        assert first["well_position"] == "A1"
        assert first["row_label"] == "A"
        assert first["column_label"] == 1
        assert first["value"] == pytest.approx(0.1736)

    def test_last_well(self) -> None:
        last = self.df.iloc[-1]
        assert last["well_position"] == "D12"
        assert last["row_label"] == "D"
        assert last["column_label"] == 12
        assert last["value"] == pytest.approx(0.0651)

    def test_empty_rows_excluded(self) -> None:
        assert set(self.df["row_label"].unique()) == {"A", "B", "C", "D"}


class TestWellScan:
    """Well Scan / Absorbance / 595 nm, 5 scan positions."""

    @pytest.fixture(autouse=True)
    def _load(self) -> None:
        self.df = parse_raw_well_data(_FIXTURES_DIR / "spectramax_plate_reader_well_scan.xls")

    def test_shape(self) -> None:
        assert self.df.shape == (480, 8)  # 5 scans × 8 rows × 12 cols

    def test_plate_name(self) -> None:
        assert self.df["plate_name"].unique().tolist() == ["Plate1"]

    def test_time_is_scan_index(self) -> None:
        assert sorted(self.df["time"].unique()) == ["1", "2", "3", "4", "5"]

    def test_wavelength(self) -> None:
        assert (self.df["wavelength"] == 595).all()

    def test_temperature(self) -> None:
        assert (self.df["temperature_c"] == 21.8).all()

    def test_rows_per_scan(self) -> None:
        for scan_idx in ["1", "2", "3", "4", "5"]:
            scan_df = self.df[self.df["time"] == scan_idx]
            assert len(scan_df) == 96  # 8 rows × 12 cols

    def test_all_rows_populated(self) -> None:
        assert set(self.df["row_label"].unique()) == set("ABCDEFGH")

    def test_first_well_scan_1(self) -> None:
        first = self.df.iloc[0]
        assert first["time"] == "1"
        assert first["well_position"] == "A1"
        assert first["value"] == pytest.approx(0.1183)

    def test_first_well_scan_2(self) -> None:
        scan2 = self.df[self.df["time"] == "2"].iloc[0]
        assert scan2["well_position"] == "A1"
        assert scan2["value"] == pytest.approx(0.1148)


class TestEndpointSparse:
    """Endpoint / Absorbance / 600 nm — plate header reports num_cols=4 but
    the actual grid is 12 columns wide with only 4 values populated in row A.
    This exercises the column-count derivation from the header row.
    """

    @pytest.fixture(autouse=True)
    def _load(self) -> None:
        self.df = parse_raw_well_data(_FIXTURES_DIR / "spectramax_plate_reader_endpoint_sparse.xls")

    def test_columns(self) -> None:
        assert list(self.df.columns) == _EXPECTED_COLUMNS

    def test_shape(self) -> None:
        assert self.df.shape == (4, 8)  # only 4 wells populated (A1–A4)

    def test_plate_name(self) -> None:
        assert self.df["plate_name"].unique().tolist() == ["Plate1"]

    def test_time_is_null(self) -> None:
        assert bool(self.df["time"].isna().all())

    def test_wavelength(self) -> None:
        assert (self.df["wavelength"] == 600).all()

    def test_temperature(self) -> None:
        assert (self.df["temperature_c"] == 22.8).all()

    def test_well_positions(self) -> None:
        assert self.df["well_position"].tolist() == ["A1", "A2", "A3", "A4"]

    def test_first_well(self) -> None:
        first = self.df.iloc[0]
        assert first["well_position"] == "A1"
        assert first["value"] == pytest.approx(0.316717714285714)

    def test_last_well(self) -> None:
        last = self.df.iloc[-1]
        assert last["well_position"] == "A4"
        assert last["value"] == pytest.approx(0.0667328100470958)

    def test_empty_rows_excluded(self) -> None:
        assert set(self.df["row_label"].unique()) == {"A"}


class TestFluorescence:
    """Endpoint / Fluorescence / 512 nm — plate header has a different field
    layout (extra field before 'Raw') that shifts column positions.
    """

    @pytest.fixture(autouse=True)
    def _load(self) -> None:
        self.df = parse_raw_well_data(_FIXTURES_DIR / "spectramax_plate_reader_fluorescence.xls")

    def test_columns(self) -> None:
        assert list(self.df.columns) == _EXPECTED_COLUMNS

    def test_shape(self) -> None:
        assert self.df.shape == (2, 8)

    def test_plate_name(self) -> None:
        assert self.df["plate_name"].unique().tolist() == ["Plate2"]

    def test_time_is_null(self) -> None:
        assert bool(self.df["time"].isna().all())

    def test_wavelength(self) -> None:
        assert (self.df["wavelength"] == 512).all()

    def test_temperature(self) -> None:
        assert (self.df["temperature_c"] == 21.3).all()

    def test_well_positions(self) -> None:
        assert self.df["well_position"].tolist() == ["A1", "A2"]

    def test_first_well(self) -> None:
        first = self.df.iloc[0]
        assert first["value"] == pytest.approx(1185426.0)

    def test_last_well(self) -> None:
        last = self.df.iloc[-1]
        assert last["value"] == pytest.approx(1586385.0)


class TestKinetic:
    """Kinetic / Absorbance / 595 nm, 241 time points, 2 plates."""

    @pytest.fixture(autouse=True)
    def _load(self) -> None:
        self.df = parse_raw_well_data(_FIXTURES_DIR / "spectramax_plate_reader_kinetic.xls")

    def test_shape(self) -> None:
        assert self.df.shape == (46272, 8)  # 241 × 96 × 2 plates

    def test_plates(self) -> None:
        assert self.df["plate_name"].unique().tolist() == ["Plate4", "Plate5"]

    def test_time_points_per_plate(self) -> None:
        for plate in ["Plate4", "Plate5"]:
            times = self.df.loc[self.df["plate_name"] == plate, "time"].unique()
            assert len(times) == 241
            assert times[0] == "00:00:00"

    def test_wavelength(self) -> None:
        assert (self.df["wavelength"] == 595).all()

    def test_rows_per_time_point_per_plate(self) -> None:
        plate4_t0 = self.df[(self.df["plate_name"] == "Plate4") & (self.df["time"] == "00:00:00")]
        assert len(plate4_t0) == 96

    def test_plate4_first_well(self) -> None:
        first = self.df.iloc[0]
        assert first["plate_name"] == "Plate4"
        assert first["time"] == "00:00:00"
        assert first["well_position"] == "A1"
        assert first["temperature_c"] == pytest.approx(29.9)
        assert first["value"] == pytest.approx(0.0825)

    def test_plate5_first_well(self) -> None:
        plate5 = self.df[self.df["plate_name"] == "Plate5"].iloc[0]
        assert plate5["time"] == "00:00:00"
        assert plate5["well_position"] == "A1"
        assert plate5["temperature_c"] == pytest.approx(29.9)
        assert plate5["value"] == pytest.approx(0.1098)

    def test_plate5_row_count(self) -> None:
        assert len(self.df[self.df["plate_name"] == "Plate5"]) == 241 * 96


class TestEndpointFlat:
    """Endpoint / Absorbance / 595 nm — flat layout where all 96 wells appear
    on a single data line with well-position column headers (A1, A2, …, H12).
    """

    @pytest.fixture(autouse=True)
    def _load(self) -> None:
        self.df = parse_raw_well_data(_FIXTURES_DIR / "spectramax_plate_reader_endpoint_flat.xls")

    def test_columns(self) -> None:
        assert list(self.df.columns) == _EXPECTED_COLUMNS

    def test_shape(self) -> None:
        assert self.df.shape == (96, 8)

    def test_plate_name(self) -> None:
        assert self.df["plate_name"].unique().tolist() == ["Plate1"]

    def test_time_is_null(self) -> None:
        assert bool(self.df["time"].isna().all())

    def test_wavelength(self) -> None:
        assert (self.df["wavelength"] == 595).all()

    def test_temperature(self) -> None:
        assert self.df["temperature_c"].unique() == pytest.approx([29.9])

    def test_first_well(self) -> None:
        first = self.df.iloc[0]
        assert first["well_position"] == "A1"
        assert first["row_label"] == "A"
        assert first["column_label"] == 1
        assert first["value"] == pytest.approx(0.1887)

    def test_last_well(self) -> None:
        last = self.df.iloc[-1]
        assert last["well_position"] == "H12"
        assert last["row_label"] == "H"
        assert last["column_label"] == 12
        assert last["value"] == pytest.approx(0.1648)

    def test_all_rows_populated(self) -> None:
        assert set(self.df["row_label"].unique()) == set("ABCDEFGH")


# ---------------------------------------------------------------------------
# Error handling
# ---------------------------------------------------------------------------


class TestParseRawWellDataValidation:
    def test_missing_plate_header(self, tmp_path: Path) -> None:
        path = tmp_path / "empty.xls"
        path.write_text("##BLOCKS= 1\n~End\n", encoding="utf-16")
        with pytest.raises(ValueError, match="No 'Plate:' header line found"):
            parse_raw_well_data(path)
