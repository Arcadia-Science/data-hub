from __future__ import annotations
from pathlib import Path
from typing import Any

import pytest

from data_hub_lambda.azure_cielo_qpcr.melting_curve import (
    MAX_POINTS_PER_WELL,
    build_plate_json,
    build_tidy_rows,
    is_melting_curve_filename,
    parse_melting_curve_csv,
    parse_melting_curve_file,
)

_FIXTURES_DIR = Path(__file__).resolve().parents[1] / "fixtures"


def _write_melting_csv(path: Path) -> Path:
    # Two channels, two wells, three evenly spaced temperatures (20, 20.5, 21 C).
    path.write_text(
        "Channel1 MeltingCurveData,A1,B1,\n"
        "2000,0,0,\n"
        "2050,0,0,\n"
        "2100,0,0,\n"
        "Channel2 MeltingCurveData,A1,B1,\n"
        "2000,10,20,\n"
        "2050,8,16,\n"
        "2100,6,12,\n",
        encoding="utf-8",
    )
    return path


class TestRealFixture:
    def test_fixture_matches_vendor_export_shape(self) -> None:
        parsed = parse_melting_curve_file(_FIXTURES_DIR / "azure_cielo_qpcr_MeltingCurve.csv")
        assert [block.channel for block in parsed.blocks] == [
            "Channel1",
            "Channel2",
            "Channel3",
            "Channel4",
        ]
        assert all(len(block.wells) == 96 for block in parsed.blocks)
        assert len(parsed.blocks[0].wells["A1"]) == 152
        assert parsed.blocks[0].wells["A1"][0] == (20.0, 0.0)
        assert parsed.blocks[0].wells["A1"][-1][0] == 95.5
        assert len(parsed.tidy_rows) == 4 * 96 * 152
        assert all(
            row["fluorescence"] == 0.0 for row in parsed.tidy_rows if row["channel"] == "Channel1"
        )


def test_filename_gate() -> None:
    assert is_melting_curve_filename("Experiment_20260101_MeltingCurve.csv")
    assert is_melting_curve_filename("run_meltingcurve.CSV")
    assert not is_melting_curve_filename("Experiment_20260101_Cq Values.csv")
    assert not is_melting_curve_filename("Experiment_20260101_Melting Curve.csv")


def test_parse_channel_blocks(tmp_path: Path) -> None:
    path = _write_melting_csv(tmp_path / "melt.csv")
    blocks = parse_melting_curve_csv(path)
    assert [b.channel for b in blocks] == ["Channel1", "Channel2"]
    assert list(blocks[1].wells) == ["A1", "B1"]
    assert blocks[1].wells["A1"] == [(20.0, 10.0), (20.5, 8.0), (21.0, 6.0)]


def test_parse_rejects_empty_file(tmp_path: Path) -> None:
    path = tmp_path / "empty.csv"
    path.write_text("not a melting curve\n", encoding="utf-8")
    with pytest.raises(ValueError, match="MeltingCurveData"):
        parse_melting_curve_csv(path)


def test_tidy_rows_and_zero_channel(tmp_path: Path) -> None:
    path = _write_melting_csv(tmp_path / "melt.csv")
    parsed = parse_melting_curve_file(path)
    assert len(parsed.tidy_rows) == 12
    a1 = [r for r in parsed.tidy_rows if r["channel"] == "Channel2" and r["well"] == "A1"]
    assert a1[0]["fluorescence"] == 10.0
    assert a1[0]["fluorescence_pct_max"] == 100.0
    # Linear F vs T: 10, 8, 6 over 0.5 C steps. dF/dT = -4, so -dF/dT = 4.
    assert a1[0]["neg_dF_dT"] == 4.0
    assert a1[1]["neg_dF_dT"] == 4.0
    assert a1[2]["neg_dF_dT"] == 4.0

    dark = [r for r in parsed.tidy_rows if r["channel"] == "Channel1" and r["well"] == "A1"]
    assert dark[0]["fluorescence"] == 0.0
    assert dark[0]["neg_dF_dT"] == 0.0


def test_plate_json_thins_long_series() -> None:
    temps = [20.0 + 0.5 * i for i in range(50)]
    fluor = [10.0 - 0.1 * i for i in range(50)]
    from data_hub_lambda.azure_cielo_qpcr.melting_curve import ChannelBlock

    block = ChannelBlock(channel="Channel2", wells={"A1": list(zip(temps, fluor, strict=True))})
    plate = build_plate_json([block])
    channels: list[dict[str, Any]] = plate["channels"]  # type: ignore[assignment]
    points: list[dict[str, float]] = channels[0]["wells"][0]["points"]
    assert len(points) == MAX_POINTS_PER_WELL
    assert points[0]["x"] == 20.0


def test_build_tidy_rows_skips_empty_wells() -> None:
    from data_hub_lambda.azure_cielo_qpcr.melting_curve import ChannelBlock

    block = ChannelBlock(channel="Channel2", wells={"A1": [], "B1": [(20.0, 1.0)]})
    rows = build_tidy_rows([block])
    assert [r["well"] for r in rows] == ["B1"]
