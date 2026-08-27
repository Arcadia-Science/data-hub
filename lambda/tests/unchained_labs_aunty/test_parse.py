"""Parser tests for Unchained Labs Aunty Excel exports."""

from __future__ import annotations
from pathlib import Path

import pytest

from data_hub_lambda.unchained_labs_aunty.utils import (
    AuntyParseError,
    downsample_points,
    parse_aunty_workbook,
    round_points,
    write_curves_csv,
    write_plate_json,
)

from .workbook_factory import (
    isothermal_experiment,
    sizing_experiment,
    thermal_experiment,
    write_aunty_workbook,
)


def test_thermal_ramp_workbook(tmp_path: Path) -> None:
    path = tmp_path / "thermal.xlsx"
    write_aunty_workbook(
        path,
        [thermal_experiment("Thermal ramp seed T0900", ["A1", "B1", "C1"])],
    )

    parsed = parse_aunty_workbook(path)

    assert parsed.metadata["experiment_type"] == "thermal_ramp"
    assert parsed.metadata["analysis_mode"] == "BCM"
    assert parsed.metadata["start_temp_c"] == 25
    assert parsed.metadata["end_temp_c"] == 95
    assert parsed.metadata["rate_c_per_min"] == 1
    assert parsed.metadata["experiment_count"] == 1

    assert len(parsed.experiments) == 1
    experiment = parsed.experiments[0]
    assert experiment["flavor"] == "thermal_ramp"
    assert experiment["primarySeries"] == "fluorescence"
    assert experiment["analysisMode"] == "BCM"
    assert [w["well"] for w in experiment["wells"]] == ["A1", "B1", "C1"]

    a1 = experiment["wells"][0]
    assert a1["values"]["tm1"] == pytest.approx(64.6)
    assert a1["values"]["tm2"] is None
    assert "fluorescence" in a1["series"]
    assert len(a1["series"]["fluorescence"]) == 8

    series_ids = {row.series for row in parsed.curve_rows}
    assert series_ids == {
        "fluorescence",
        "differential",
        "z_average_diameter",
        "sls",
    }
    a1_fluor = [
        row for row in parsed.curve_rows if row.well == "A1" and row.series == "fluorescence"
    ]
    assert a1_fluor[0].x == pytest.approx(25.0)
    assert a1_fluor[-1].x == pytest.approx(95.0)


def test_sizing_workbook(tmp_path: Path) -> None:
    path = tmp_path / "sizing.xlsx"
    write_aunty_workbook(
        path,
        [sizing_experiment("Sizing seed T1000", ["A1", "H12"])],
    )

    parsed = parse_aunty_workbook(path)
    assert parsed.metadata["experiment_type"] == "sizing"
    experiment = parsed.experiments[0]
    assert experiment["flavor"] == "sizing"
    assert experiment["primarySeries"] == "correlation"
    assert [w["well"] for w in experiment["wells"]] == ["A1", "H12"]

    a1 = experiment["wells"][0]
    assert a1["values"]["z_avg_diameter"] == pytest.approx(75.0)
    assert set(a1["series"]) == {"correlation", "intensity", "mass"}

    intensity_peak_x = max(a1["series"]["intensity"], key=lambda p: p[1])[0]
    mass_peak_x = max(a1["series"]["mass"], key=lambda p: p[1])[0]
    assert intensity_peak_x == pytest.approx(a1["values"]["pk1_diameter"], rel=0.5)
    assert mass_peak_x < intensity_peak_x


def test_two_experiment_workbook(tmp_path: Path) -> None:
    path = tmp_path / "two.xlsx"
    write_aunty_workbook(
        path,
        [
            sizing_experiment("Sizing seed T1120", ["A1", "B1"], z_avg=80.0),
            sizing_experiment("Sizing seed T1342", ["A1", "B1"], z_avg=120.0),
        ],
    )

    parsed = parse_aunty_workbook(path)
    assert parsed.metadata["experiment_count"] == 2
    assert [exp["fileName"] for exp in parsed.experiments] == [
        "Sizing seed T1120",
        "Sizing seed T1342",
    ]
    first_a1 = parsed.experiments[0]["wells"][0]
    second_a1 = parsed.experiments[1]["wells"][0]
    assert first_a1["well"] == second_a1["well"] == "A1"
    assert first_a1["values"]["z_avg_diameter"] == pytest.approx(80.0)
    assert second_a1["values"]["z_avg_diameter"] == pytest.approx(120.0)

    first_rows = [r for r in parsed.curve_rows if r.file_name.endswith("T1120")]
    second_rows = [r for r in parsed.curve_rows if r.file_name.endswith("T1342")]
    assert first_rows and second_rows


def test_thermal_without_z_average(tmp_path: Path) -> None:
    path = tmp_path / "tm_tagg.xlsx"
    write_aunty_workbook(
        path,
        [
            thermal_experiment(
                "Tm Tagg Thermal ramp seed T1049",
                ["A1", "B1"],
                include_series={"fluorescence", "differential", "sls"},
            )
        ],
    )

    parsed = parse_aunty_workbook(path)
    experiment = parsed.experiments[0]
    assert experiment["flavor"] == "thermal_ramp"
    assert set(experiment["wells"][0]["series"]) == {
        "fluorescence",
        "differential",
        "sls",
    }
    assert "z_average_diameter" not in experiment["wells"][0]["series"]


def test_isothermal_fluorescence_only(tmp_path: Path) -> None:
    path = tmp_path / "isothermal.xlsx"
    write_aunty_workbook(
        path,
        [isothermal_experiment("Blue Isothermal seed T1016", ["G2", "H2"])],
    )

    parsed = parse_aunty_workbook(path)
    assert parsed.metadata["experiment_type"] == "isothermal"
    experiment = parsed.experiments[0]
    assert experiment["flavor"] == "isothermal"
    assert experiment["primarySeries"] == "fluorescence"
    assert experiment["analysisMode"] == "Peak height"
    assert [w["well"] for w in experiment["wells"]] == ["G2", "H2"]
    assert set(experiment["wells"][0]["series"]) == {"fluorescence"}
    assert experiment["wells"][0]["values"]["fluor_k1"] == pytest.approx(0.0034)
    xs = [row.x for row in parsed.curve_rows if row.well == "G2"]
    assert xs[0] == pytest.approx(0.0)
    assert xs[-1] == pytest.approx(420.0)


def test_isothermal_with_sls(tmp_path: Path) -> None:
    path = tmp_path / "isothermal_sls.xlsx"
    write_aunty_workbook(
        path,
        [
            isothermal_experiment(
                "UV Scatter Isothermal seed T1042",
                ["A1"],
                with_sls=True,
            )
        ],
    )

    parsed = parse_aunty_workbook(path)
    well = parsed.experiments[0]["wells"][0]
    assert set(well["series"]) == {"fluorescence", "sls"}
    assert well["values"]["sls_k1"] == pytest.approx(0.00136)
    series_ids = {row.series for row in parsed.curve_rows}
    assert series_ids == {"fluorescence", "sls"}


def test_table_only_thermal(tmp_path: Path) -> None:
    path = tmp_path / "table_only_thermal.xlsx"
    write_aunty_workbook(
        path,
        [thermal_experiment("Thermal ramp seed T1627", ["A1", "C1"])],
        include_graph=False,
    )

    parsed = parse_aunty_workbook(path)
    assert parsed.metadata["experiment_type"] == "thermal_ramp"
    assert parsed.curve_rows == []
    experiment = parsed.experiments[0]
    assert experiment["flavor"] == "thermal_ramp"
    assert [w["well"] for w in experiment["wells"]] == ["A1", "C1"]
    assert experiment["wells"][0]["series"] == {}
    assert experiment["wells"][0]["values"]["tm1"] == pytest.approx(64.6)


def test_table_only_sizing(tmp_path: Path) -> None:
    path = tmp_path / "table_only_sizing.xlsx"
    write_aunty_workbook(
        path,
        [sizing_experiment("Sizing seed T1556", ["A1", "B1"], z_avg=80.0)],
        include_graph=False,
    )

    parsed = parse_aunty_workbook(path)
    assert parsed.metadata["experiment_type"] == "sizing"
    well = parsed.experiments[0]["wells"][0]
    assert well["series"] == {}
    assert well["values"]["z_avg_diameter"] == pytest.approx(80.0)


def test_missing_graph_sheet(tmp_path: Path) -> None:
    from openpyxl import Workbook

    path = tmp_path / "empty.xlsx"
    wb = Workbook()
    sheet = wb.active
    assert sheet is not None
    sheet.title = "Results"
    wb.save(path)

    with pytest.raises(AuntyParseError, match="Analysis_graph"):
        parse_aunty_workbook(path)


def test_downsample_keeps_endpoints() -> None:
    points = [[float(i), float(i)] for i in range(100)]
    out = downsample_points(points, max_points=10)
    assert out[0] == [0.0, 0.0]
    assert out[-1] == [99.0, 99.0]
    assert len(out) == 10


def test_round_points_trims_digits_and_keeps_tiny_values() -> None:
    out = round_points([[4.0e-07, 330.1234567890123], [0.0, -1.5e-09]])
    assert out[0] == [4.0e-07, 330.123]
    assert out[1] == [0.0, -1.5e-09]


def test_thumbnails_are_smaller_than_full_precision(tmp_path: Path) -> None:
    path = tmp_path / "sizing.xlsx"
    write_aunty_workbook(path, [sizing_experiment("Sizing seed T1000", ["A1"])])
    parsed = parse_aunty_workbook(path)

    thumbs = parsed.experiments[0]["wells"][0]["series"]["correlation"]
    # Rounding must not collapse the sub-microsecond correlation x values.
    assert all(x > 0 for x, _y in thumbs)
    assert all(len(repr(y)) <= 12 for _x, y in thumbs)


def test_artifact_writers(tmp_path: Path) -> None:
    workbook = tmp_path / "thermal.xlsx"
    write_aunty_workbook(
        workbook,
        [thermal_experiment("Thermal ramp seed T0900", ["A1"])],
    )
    parsed = parse_aunty_workbook(workbook)

    csv_path = tmp_path / "curves.csv"
    json_path = tmp_path / "plate.json"
    write_curves_csv(csv_path, parsed.curve_rows)
    write_plate_json(json_path, parsed.experiments)

    csv_text = csv_path.read_text(encoding="utf-8")
    assert csv_text.splitlines()[0] == "file_name,analysis_mode,well,sample,series,x,y"
    assert "fluorescence" in csv_text
    assert '"flavor": "thermal_ramp"' in json_path.read_text(encoding="utf-8")


def test_seed_fixtures_parse() -> None:
    fixtures = Path(__file__).resolve().parents[1] / "fixtures"
    thermal = parse_aunty_workbook(fixtures / "aunty_thermal_ramp.xlsx")
    assert thermal.metadata["experiment_type"] == "thermal_ramp"
    assert len(thermal.experiments[0]["wells"]) == 96

    sizing = parse_aunty_workbook(fixtures / "aunty_sizing.xlsx")
    assert sizing.metadata["experiment_type"] == "sizing"
    assert len(sizing.experiments[0]["wells"]) == 96
    a1 = sizing.experiments[0]["wells"][0]
    mass_peak_x = max(a1["series"]["mass"], key=lambda p: p[1])[0]
    intensity_peak_x = max(a1["series"]["intensity"], key=lambda p: p[1])[0]
    assert mass_peak_x < intensity_peak_x

    isothermal = parse_aunty_workbook(fixtures / "aunty_isothermal.xlsx")
    assert isothermal.metadata["experiment_type"] == "isothermal"
    assert len(isothermal.experiments[0]["wells"]) == 12

    table_only = parse_aunty_workbook(fixtures / "aunty_table_only.xlsx")
    assert table_only.metadata["experiment_type"] == "thermal_ramp"
    assert table_only.curve_rows == []
    assert len(table_only.experiments[0]["wells"]) == 24
