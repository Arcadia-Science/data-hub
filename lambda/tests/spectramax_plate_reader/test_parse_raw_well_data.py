from __future__ import annotations
import math
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


class TestKineticEdgeWellsSkipped:
    """Kinetic / Absorbance / 595 nm with edge wells unselected.

    SoftMax Pro leaves rows A/H and columns 1/12 empty and writes elapsed
    time + temperature on the first populated row (B), not row A. The parser
    must still attach those fields to every well in the reading group.
    """

    @pytest.fixture(autouse=True)
    def _load(self) -> None:
        self.df = parse_raw_well_data(
            _FIXTURES_DIR / "spectramax_plate_reader_kinetic_edge_wells_skipped.xls"
        )

    def test_columns(self) -> None:
        assert list(self.df.columns) == _EXPECTED_COLUMNS

    def test_shape(self) -> None:
        # 2 time points × 6 rows (B–G) × 9 cols (2–10)
        assert self.df.shape == (108, 8)

    def test_time_points(self) -> None:
        times = self.df["time"].unique().tolist()
        assert times == ["00:00:00", "00:15:01"]

    def test_time_and_temperature_not_null(self) -> None:
        assert bool(self.df["time"].notna().all())
        assert bool(self.df["temperature_c"].notna().all())

    def test_wells_exclude_edges(self) -> None:
        wells = set(self.df["well_position"])
        assert "A1" not in wells
        assert "H12" not in wells
        assert wells == {f"{r}{c}" for r in "BCDEFG" for c in range(2, 11)}

    def test_first_well(self) -> None:
        first = self.df.iloc[0]
        assert first["time"] == "00:00:00"
        assert first["well_position"] == "B2"
        assert first["temperature_c"] == pytest.approx(30.2)
        assert first["value"] == pytest.approx(0.1020)

    def test_second_time_point(self) -> None:
        t1 = self.df[self.df["time"] == "00:15:01"]
        assert len(t1) == 54
        first = t1.iloc[0]
        assert first["well_position"] == "B2"
        assert first["temperature_c"] == pytest.approx(30.0)
        assert first["value"] == pytest.approx(0.1120)


class TestIncompleteKinetic:
    """SoftMax may declare more Kinetic readings than it exports when a run
    stops early. Emit the groups that are present (including day-prefixed
    times after 24 h) and stop before the summary / ``~End``.
    """

    @pytest.fixture(autouse=True)
    def _load(self, tmp_path: Path) -> None:
        prefix = "Plate:\tPlate1\t1.3\tPlateFormat"
        # Header claims 4 readings; file only has 2 (+ summary).
        middle = "\tRaw\tFALSE\t4\t\t\t\t\t\t1"
        header = f"{prefix}\tKinetic\tAbsorbance{middle}\t595\t1\t2\t4\t1\t2\n"
        col_header = "\tTemperature(\xa1C)\t1\t2\t\n"
        r0 = "00:00:00\t30.0\t0.10\t0.20\t\n"
        r1 = "\t\t0.30\t0.40\t\n"
        blank = "\n"
        # Day-prefixed elapsed time once the run crosses 24 h.
        r2 = "1.00:05:20\t30.1\t0.11\t0.21\t\n"
        r3 = "\t\t0.31\t0.41\t\n"
        summary = "\t\t1\t2\t\n\t\t0.10\t0.20\t\n\t\t0.30\t0.40\t\n"
        content = f"##BLOCKS= 1\n{header}{col_header}{r0}{r1}{blank}{r2}{r3}{blank}{summary}~End\n"
        path = tmp_path / "incomplete_kinetic.xls"
        path.write_text(content, encoding="utf-16")
        self.df = parse_raw_well_data(path)

    def test_columns(self) -> None:
        assert list(self.df.columns) == _EXPECTED_COLUMNS

    def test_shape_uses_exported_readings_only(self) -> None:
        # 2 exported readings × 4 wells — not the declared 4, and not the summary.
        assert self.df.shape == (8, 8)

    def test_times_include_day_prefix(self) -> None:
        assert self.df["time"].unique().tolist() == ["00:00:00", "1.00:05:20"]

    def test_values(self) -> None:
        t0 = self.df[self.df["time"] == "00:00:00"]["value"].tolist()
        t1 = self.df[self.df["time"] == "1.00:05:20"]["value"].tolist()
        assert t0 == pytest.approx([0.10, 0.20, 0.30, 0.40])
        assert t1 == pytest.approx([0.11, 0.21, 0.31, 0.41])

    def test_stops_at_end_without_summary(self, tmp_path: Path) -> None:
        prefix = "Plate:\tPlate1\t1.3\tPlateFormat"
        middle = "\tRaw\tFALSE\t3\t\t\t\t\t\t1"
        header = f"{prefix}\tKinetic\tAbsorbance{middle}\t595\t1\t2\t4\t1\t2\n"
        col_header = "\tTemperature(\xa1C)\t1\t2\t\n"
        r0 = "00:00:00\t30.0\t0.10\t0.20\t\n"
        r1 = "\t\t0.30\t0.40\t\n"
        content = f"##BLOCKS= 1\n{header}{col_header}{r0}{r1}\n~End\n"
        path = tmp_path / "incomplete_kinetic_no_summary.xls"
        path.write_text(content, encoding="utf-16")
        df = parse_raw_well_data(path)
        assert df.shape == (4, 8)
        assert df["time"].unique().tolist() == ["00:00:00"]


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


class TestSpectrum:
    """96-well Spectrum matching iD5 production well occupancy.

    Populated wells are A1–A5 and B1–B10 on a 12-column grid (15 unique
    wells). SoftMax reuses ``Plate1``; the later absorbance scan is
    suffixed with its window. Values are synthetic; the header layout
    matches SoftMax Spectrum (window at Raw+5/6/7, empty wavelength
    field, col0 = nm).
    """

    @pytest.fixture(autouse=True)
    def _load(self) -> None:
        self.df = parse_raw_well_data(_FIXTURES_DIR / "spectramax_plate_reader_spectrum.xls")

    def test_columns(self) -> None:
        assert list(self.df.columns) == _EXPECTED_COLUMNS

    def test_shape(self) -> None:
        # 4 wells × 3 wl + 5 wells × 3 wl + 10 wells × 3 wl
        assert self.df.shape == (57, 8)

    def test_time_is_null(self) -> None:
        assert bool(self.df["time"].isna().all())

    def test_unique_wells_match_id5(self) -> None:
        wells = set(self.df["well_position"].unique().tolist())
        expected = {f"A{c}" for c in range(1, 6)} | {f"B{c}" for c in range(1, 11)}
        assert wells == expected

    def test_grid_extent_matches_id5(self) -> None:
        assert max(self.df["column_label"].unique().tolist()) == 10
        assert set(self.df["row_label"].unique().tolist()) == {"A", "B"}

    def test_plate_names_disambiguated(self) -> None:
        assert self.df["plate_name"].unique().tolist() == [
            "Plate1",
            "Plate2",
            "Plate1 (480–500)",
        ]

    def test_first_block_wavelengths(self) -> None:
        first = self.df.loc[self.df["plate_name"] == "Plate1"]
        assert sorted(first["wavelength"].unique().tolist()) == [440, 445, 450]
        assert len(first) == 12

    def test_second_block_wavelengths(self) -> None:
        second = self.df.loc[self.df["plate_name"] == "Plate2"]
        assert sorted(second["wavelength"].unique().tolist()) == [430, 435, 440]
        assert len(second) == 15

    def test_duplicate_plate_wells(self) -> None:
        third = self.df.loc[self.df["plate_name"] == "Plate1 (480–500)"]
        assert set(third["well_position"].unique().tolist()) == {f"B{c}" for c in range(1, 11)}
        assert len(third) == 30

    def test_spectrum_values_from_col0_wavelength(self) -> None:
        row = self.df.loc[
            (self.df["plate_name"] == "Plate1")
            & (self.df["wavelength"] == 440)
            & (self.df["well_position"] == "A1")
        ].iloc[0]
        assert row["temperature_c"] == pytest.approx(22.7)
        assert row["value"] == pytest.approx(1.014)

    def test_wells(self) -> None:
        first = self.df.loc[self.df["plate_name"] == "Plate1"]
        assert set(first["well_position"].unique().tolist()) == {"A1", "A2", "A3", "A4"}


class TestSpectrum384:
    """384-well Spectrum + trailing 96-well Endpoint.

    The first Spectrum block fills B1–B24 so the 24-column grid is
    actually occupied (wide plate-map layout). Later Spectrum blocks keep
    the sparser A1–A5 / B8–B11 occupancy; the Endpoint block is 96-well.
    Values are synthetic; the header layout matches SoftMax Spectrum
    (window at Raw+5/6/7, empty wavelength field, col0 = nm).
    """

    @pytest.fixture(autouse=True)
    def _load(self) -> None:
        self.df = parse_raw_well_data(_FIXTURES_DIR / "spectramax_plate_reader_spectrum_384.xls")

    def test_columns(self) -> None:
        assert list(self.df.columns) == _EXPECTED_COLUMNS

    def test_shape(self) -> None:
        # 24×3 + 5×3 + 4×3 + 24 endpoint
        assert self.df.shape == (123, 8)

    def test_time_is_null(self) -> None:
        assert bool(self.df["time"].isna().all())

    def test_unique_wells(self) -> None:
        wells = set(self.df["well_position"].unique().tolist())
        expected = {f"A{c}" for c in range(1, 13)} | {f"B{c}" for c in range(1, 25)}
        assert wells == expected

    def test_spectrum_extent_is_384_wide(self) -> None:
        spectrum = self.df.loc[self.df["plate_name"] != "Plate1 (595)"]
        assert max(spectrum["column_label"].unique().tolist()) == 24
        assert set(spectrum["row_label"].unique().tolist()) == {"A", "B"}

    def test_plate_names_disambiguated(self) -> None:
        assert self.df["plate_name"].unique().tolist() == [
            "Plate5",
            "Plate1",
            "Plate1 (500–520)",
            "Plate1 (595)",
        ]

    def test_first_block_wells(self) -> None:
        first = self.df.loc[self.df["plate_name"] == "Plate5"]
        assert set(first["well_position"].unique().tolist()) == {f"B{c}" for c in range(1, 25)}
        assert len(first) == 72

    def test_trailing_endpoint(self) -> None:
        endpoint = self.df.loc[self.df["plate_name"] == "Plate1 (595)"]
        assert len(endpoint) == 24
        assert (endpoint["wavelength"] == 595).all()
        assert max(endpoint["column_label"].unique().tolist()) == 12
        assert set(endpoint["well_position"].unique().tolist()) == {
            f"{r}{c}" for r in "AB" for c in range(1, 13)
        }


class TestIncompleteSpectrum:
    """SoftMax may declare more Spectrum readings than it exports.

    Emit the groups that are present and stop before the summary / ``~End``
    instead of raising IndexError.
    """

    @pytest.fixture(autouse=True)
    def _load(self, tmp_path: Path) -> None:
        prefix = "Plate:\tPlate1\t1.3\tPlateFormat"
        # Header window is 440–455 / 5 (4 points) and claims 4 readings;
        # file only has 2 groups (+ summary).
        middle = "\tRaw\tFALSE\t4\t\t\t440\t455\t5\t\t\t1\t2\t4"
        header = f"{prefix}\tSpectrum\tAbsorbance{middle}\n"
        col_header = "\tTemperature(\xa1C)\t1\t2\t\n"
        r0 = "440\t30.0\t0.10\t0.20\t\n"
        r1 = "\t\t0.30\t0.40\t\n"
        blank = "\n"
        r2 = "445\t30.1\t0.11\t0.21\t\n"
        r3 = "\t\t0.31\t0.41\t\n"
        summary = "\t\t1\t2\t\n\t\t0.10\t0.20\t\n\t\t0.30\t0.40\t\n"
        content = f"##BLOCKS= 1\n{header}{col_header}{r0}{r1}{blank}{r2}{r3}{blank}{summary}~End\n"
        path = tmp_path / "incomplete_spectrum.xls"
        path.write_text(content, encoding="utf-16")
        self.df = parse_raw_well_data(path)

    def test_shape_uses_exported_readings_only(self) -> None:
        assert self.df.shape == (8, 8)

    def test_wavelengths(self) -> None:
        assert self.df["wavelength"].unique().tolist() == [440, 445]

    def test_time_is_null(self) -> None:
        assert bool(self.df["time"].isna().all())

    def test_stops_at_end_without_summary(self, tmp_path: Path) -> None:
        prefix = "Plate:\tPlate1\t1.3\tPlateFormat"
        middle = "\tRaw\tFALSE\t3\t\t\t440\t450\t5\t\t\t1\t2\t4"
        header = f"{prefix}\tSpectrum\tAbsorbance{middle}\n"
        col_header = "\tTemperature(\xa1C)\t1\t2\t\n"
        r0 = "440\t30.0\t0.10\t0.20\t\n"
        r1 = "\t\t0.30\t0.40\t\n"
        content = f"##BLOCKS= 1\n{header}{col_header}{r0}{r1}\n~End\n"
        path = tmp_path / "incomplete_spectrum_no_summary.xls"
        path.write_text(content, encoding="utf-16")
        df = parse_raw_well_data(path)
        assert df.shape == (4, 8)
        assert df["wavelength"].unique().tolist() == [440]


class TestDuplicatePlateNames:
    """Three blocks sharing a SoftMax plate name must not merge."""

    def test_third_endpoint_keeps_full_wavelength_suffix(self, tmp_path: Path) -> None:
        def block(wavelength: str, value: str) -> str:
            prefix = "Plate:\tPlate1\t1.3\tPlateFormat"
            middle = "\tRaw\tFALSE\t1\t\t\t\t\t\t1"
            header = f"{prefix}\tEndpoint\tAbsorbance{middle}\t{wavelength}\t1\t2\t2\t1\t2\n"
            col_header = "\tTemperature(\xa1C)\t1\t2\t\n"
            row = f"\t25.0\t{value}\t{value}\t\n"
            return f"{header}{col_header}{row}\n~End\n"

        content = (
            "##BLOCKS= 3\n"
            + block("595 750", "1.0")
            + block("595 800", "2.0")
            + block("595 900", "3.0")
        )
        path = tmp_path / "dup_endpoint.xls"
        path.write_text(content, encoding="utf-16")
        df = parse_raw_well_data(path)
        assert df["plate_name"].unique().tolist() == [
            "Plate1",
            "Plate1 (595 800)",
            "Plate1 (595 900)",
        ]
        assert df.loc[df["plate_name"] == "Plate1", "value"].tolist() == pytest.approx([1.0, 1.0])
        assert df.loc[df["plate_name"] == "Plate1 (595 900)", "value"].tolist() == pytest.approx(
            [3.0, 3.0]
        )

    def test_third_identical_spectrum_window_gets_counter(self, tmp_path: Path) -> None:
        def block(value: str) -> str:
            header = (
                "Plate:\tPlate1\t1.3\tPlateFormat\tSpectrum\tAbsorbance"
                "\tRaw\tFALSE\t1\t\t\t440\t440\t1\t\t\t1\t1\t1\n"
            )
            col_header = "\tTemperature(\xa1C)\t1\t\n"
            row = f"440\t25.0\t{value}\t\n"
            return f"{header}{col_header}{row}\n~End\n"

        content = "##BLOCKS= 3\n" + block("1.0") + block("2.0") + block("3.0")
        path = tmp_path / "dup_spectrum.xls"
        path.write_text(content, encoding="utf-16")
        df = parse_raw_well_data(path)
        assert df["plate_name"].unique().tolist() == [
            "Plate1",
            "Plate1 (440–440)",
            "Plate1 (440–440) (2)",
        ]
        assert df["value"].tolist() == pytest.approx([1.0, 2.0, 3.0])

    def test_counter_fallback_without_wavelength(self, tmp_path: Path) -> None:
        def block(value: str) -> str:
            prefix = "Plate:\tP\t1.3\tPlateFormat"
            middle = "\tRaw\tFALSE\t1\t\t\t\t\t\t1"
            header = f"{prefix}\tEndpoint\tAbsorbance{middle}\t\t1\t1\t1\t1\t1\n"
            col_header = "\tTemperature(\xa1C)\t1\t\n"
            row = f"\t25.0\t{value}\t\n"
            return f"{header}{col_header}{row}\n~End\n"

        content = "##BLOCKS= 3\n" + block("1.0") + block("2.0") + block("3.0")
        path = tmp_path / "dup_counter.xls"
        path.write_text(content, encoding="utf-16")
        df = parse_raw_well_data(path)
        assert df["plate_name"].unique().tolist() == ["P", "P (2)", "P (3)"]


class TestSpectrumFloatWavelengths:
    def test_float_header_and_col0(self, tmp_path: Path) -> None:
        header = (
            "Plate:\tPlate1\t1.3\tPlateFormat\tSpectrum\tAbsorbance"
            "\tRaw\tFALSE\t1\t\t\t440.0\t440.0\t1.0\t\t\t1\t1\t1\n"
        )
        col_header = "\tTemperature(\xa1C)\t1\t\n"
        row = "440.0\t25.0\t1.5\t\n"
        path = tmp_path / "float_nm.xls"
        path.write_text(f"##BLOCKS= 1\n{header}{col_header}{row}\n~End\n", encoding="utf-16")
        df = parse_raw_well_data(path)
        assert df["wavelength"].tolist() == [440]
        assert df["value"].tolist() == pytest.approx([1.5])


class TestSpectrumFlat:
    def test_flat_layout_reads_col0_wavelength(self, tmp_path: Path) -> None:
        header = (
            "Plate:\tPlate1\t1.3\tPlateFormat\tSpectrum\tAbsorbance"
            "\tRaw\tFALSE\t2\t\t\t440\t445\t5\t\t\t1\t2\t2\n"
        )
        col_header = "\tTemperature(\xa1C)\tA1\tA2\t\n"
        r0 = "440\t25.0\t0.10\t0.20\t\n"
        r1 = "445.0\t25.1\t0.11\t0.21\t\n"
        path = tmp_path / "spectrum_flat.xls"
        path.write_text(f"##BLOCKS= 1\n{header}{col_header}{r0}\n{r1}\n~End\n", encoding="utf-16")
        df = parse_raw_well_data(path)
        assert df.shape == (4, 8)
        assert sorted(df["wavelength"].unique().tolist()) == [440, 445]
        assert bool(df["time"].isna().all())
        assert df["well_position"].tolist() == ["A1", "A2", "A1", "A2"]

    """Endpoint / Absorbance / dual wavelength (750 + 600), synthetic 2×2 plate."""

    @pytest.fixture(autouse=True)
    def _load(self, tmp_path: Path) -> None:
        prefix = "Plate:\tPlate1\t1.3\tPlateFormat"
        middle = "\tRaw\tFALSE\t1\t\t\t\t\t\t2"
        header = f"{prefix}\tEndpoint\tAbsorbance{middle}\t750 600\t1\t2\t4\t1\t4\n"
        col_header = "\tTemperature(\xa1C)\t1\t2\t\t1\t2\t\t\n"
        row_a = "\t25.0\t0.10\t0.20\t\t0.50\t0.60\t\t\n"
        row_b = "\t\t0.30\t0.40\t\t0.70\t0.80\t\t\n"
        blank = "\n"
        summary_hdr = "\t\t1\t2\t\n"
        summary_a = "\t\t0.10\t0.20\t\n"
        summary_b = "\t\t0.30\t0.40\t\n"
        content = (
            f"##BLOCKS= 1\n{header}{col_header}{row_a}{row_b}"
            f"{blank}{summary_hdr}{summary_a}{summary_b}~End\n"
        )
        path = tmp_path / "dual_wl.xls"
        path.write_text(content, encoding="utf-16")
        self.df = parse_raw_well_data(path)

    def test_columns(self) -> None:
        assert list(self.df.columns) == _EXPECTED_COLUMNS

    def test_shape(self) -> None:
        assert self.df.shape == (8, 8)  # 2 rows × 2 cols × 2 wavelengths

    def test_wavelengths_present(self) -> None:
        assert sorted(self.df["wavelength"].unique()) == [600, 750]

    def test_wells_per_wavelength(self) -> None:
        for wl in [750, 600]:
            subset = self.df[self.df["wavelength"] == wl]
            assert len(subset) == 4

    def test_first_wavelength_values(self) -> None:
        wl750 = self.df.loc[self.df["wavelength"] == 750, "value"]
        assert wl750.tolist() == pytest.approx([0.10, 0.20, 0.30, 0.40])

    def test_second_wavelength_values(self) -> None:
        wl600 = self.df.loc[self.df["wavelength"] == 600, "value"]
        assert wl600.tolist() == pytest.approx([0.50, 0.60, 0.70, 0.80])

    def test_temperature(self) -> None:
        assert (self.df["temperature_c"] == 25.0).all()


class TestNonNumericSentinels:
    """SoftMax Pro emits ``Path?`` (PathCheck pathlength correction failed),
    ``Range?`` (out of dynamic range), ``#SAT`` (detector saturated), and
    ``#Low`` (missed flash) in place of a numeric value when the instrument
    couldn't produce a usable reading. Those wells should be preserved with
    ``value=NaN``, while truly empty cells continue to be omitted entirely.
    """

    @pytest.fixture(autouse=True)
    def _load(self, tmp_path: Path) -> None:
        prefix = "Plate:\tPlate1\t1.3\tPlateFormat"
        # Use 'Reduced' so the synthetic file matches real pathlength-corrected
        # exports (where 'Path?' originates) — the parser treats Raw/Reduced
        # interchangeably, but this keeps the fixture faithful.
        middle = "\tReduced\tFALSE\t1\t\t\t\t\t\t1"
        header = f"{prefix}\tEndpoint\tAbsorbance{middle}\t750\t1\t4\t8\t1\t2\n"
        col_header = "\t\t1\t2\t3\t4\t\n"
        # A1=numeric, A2=Path?, A3=empty (omitted), A4=#SAT
        # B1=Range?, B2=numeric, B3=Path?, B4=#Low
        row_a = "\t25.0\t0.10\tPath?\t\t#SAT\t\n"
        row_b = "\t\tRange?\t0.40\tPath?\t#Low\t\n"
        content = f"##BLOCKS= 1\n{header}{col_header}{row_a}{row_b}\n~End\n"
        path = tmp_path / "sentinels.xls"
        path.write_text(content, encoding="utf-16")
        self.df = parse_raw_well_data(path)

    def test_empty_cells_omitted_but_sentinels_kept(self) -> None:
        # 7 wells: A1, A2 (Path?), A4 (#SAT), B1 (Range?), B2, B3 (Path?),
        # B4 (#Low). A3 is empty.
        assert self.df["well_position"].tolist() == [
            "A1",
            "A2",
            "A4",
            "B1",
            "B2",
            "B3",
            "B4",
        ]

    def test_numeric_values_unaffected(self) -> None:
        a1 = self.df[self.df["well_position"] == "A1"].iloc[0]
        b2 = self.df[self.df["well_position"] == "B2"].iloc[0]
        assert a1["value"] == pytest.approx(0.10)
        assert b2["value"] == pytest.approx(0.40)

    def test_path_sentinel_becomes_nan(self) -> None:
        for well in ("A2", "B3"):
            value = self.df[self.df["well_position"] == well].iloc[0]["value"]
            assert math.isnan(value), f"expected NaN for {well}, got {value!r}"

    def test_range_sentinel_becomes_nan(self) -> None:
        value = self.df[self.df["well_position"] == "B1"].iloc[0]["value"]
        assert math.isnan(value)

    def test_sat_sentinel_becomes_nan(self) -> None:
        value = self.df[self.df["well_position"] == "A4"].iloc[0]["value"]
        assert math.isnan(value)

    def test_low_sentinel_becomes_nan(self) -> None:
        value = self.df[self.df["well_position"] == "B4"].iloc[0]["value"]
        assert math.isnan(value)


@pytest.mark.parametrize("token", ["#SAT", "#Sat", "#sat", "#LOW", "#Low"])
def test_hash_sentinel_casing_becomes_nan(tmp_path: Path, token: str) -> None:
    prefix = "Plate:\tPlate1\t1.3\tPlateFormat"
    middle = "\tRaw\tFALSE\t1\t\t\t\t\t\t1"
    header = f"{prefix}\tEndpoint\tAbsorbance{middle}\t750\t1\t1\t1\t1\t1\n"
    col_header = "\t\t1\t\n"
    row_a = f"\t25.0\t{token}\t\n"
    content = f"##BLOCKS= 1\n{header}{col_header}{row_a}\n~End\n"
    path = tmp_path / "hash_sentinel.xls"
    path.write_text(content, encoding="utf-16")
    df = parse_raw_well_data(path)
    assert len(df) == 1
    assert math.isnan(df.iloc[0]["value"])


# ---------------------------------------------------------------------------
# Error handling
# ---------------------------------------------------------------------------


class TestParseRawWellDataValidation:
    def test_missing_plate_header(self, tmp_path: Path) -> None:
        path = tmp_path / "empty.xls"
        path.write_text("##BLOCKS= 1\n~End\n", encoding="utf-16")
        with pytest.raises(ValueError, match="No 'Plate:' header line found"):
            parse_raw_well_data(path)

    def test_unknown_non_numeric_token_still_raises(self, tmp_path: Path) -> None:
        # Anything that isn't a documented SoftMax Pro sentinel (Path?,
        # Range?, #SAT, #Low) should still surface as a ValueError —
        # silently swallowing arbitrary garbage would hide real parser bugs.
        prefix = "Plate:\tPlate1\t1.3\tPlateFormat"
        middle = "\tRaw\tFALSE\t1\t\t\t\t\t\t1"
        header = f"{prefix}\tEndpoint\tAbsorbance{middle}\t750\t1\t1\t1\t1\t1\n"
        col_header = "\t\t1\t\n"
        row_a = "\t25.0\tnotanumber\t\n"
        content = f"##BLOCKS= 1\n{header}{col_header}{row_a}\n~End\n"
        path = tmp_path / "garbage.xls"
        path.write_text(content, encoding="utf-16")
        with pytest.raises(ValueError, match="could not convert string to float"):
            parse_raw_well_data(path)
