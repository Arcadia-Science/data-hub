from __future__ import annotations
from pathlib import Path

import pytest

from data_hub_lambda.azure_cielo_qpcr.parse_dye_channels import parse_dye_channels

_FIXTURES_DIR = Path(__file__).resolve().parents[1] / "fixtures"


# ---------------------------------------------------------------------------
# Real fixture tests
# ---------------------------------------------------------------------------


class TestRealFixture:
    """Tests against the real Cq Values CSV export in the fixtures directory."""

    def test_example_csv_has_three_dye_channels(self) -> None:
        result = parse_dye_channels(_FIXTURES_DIR / "azure_cielo_qpcr_example.csv")
        assert result == ["ORANGE 560", "TAMRA", "ROX"]

    def test_example_csv_preserves_order(self) -> None:
        result = parse_dye_channels(_FIXTURES_DIR / "azure_cielo_qpcr_example.csv")
        assert result[0] == "ORANGE 560"
        assert result[-1] == "ROX"


# ---------------------------------------------------------------------------
# Synthetic tests
# ---------------------------------------------------------------------------


def _write_csv(tmp_path: Path, header: str, rows: list[str]) -> Path:
    file_path = tmp_path / "test_cq_values.csv"
    file_path.write_text(header + "\n" + "\n".join(rows) + "\n")
    return file_path


class TestParseDyeChannels:
    def test_single_channel(self, tmp_path: Path) -> None:
        path = _write_csv(
            tmp_path,
            "Well,Sample,Target,Fluorescence,Function,Cq",
            ["A1,S1,Ch1,FAM,POS,0"],
        )
        assert parse_dye_channels(path) == ["FAM"]

    def test_multiple_channels_preserves_first_seen_order(self, tmp_path: Path) -> None:
        path = _write_csv(
            tmp_path,
            "Well,Sample,Target,Fluorescence,Function,Cq",
            [
                "A1,S1,Ch1,FAM,POS,0",
                "B1,S1,Ch2,HEX,POS,0",
                "C1,S1,Ch1,FAM,POS,0",
                "D1,S1,Ch3,CY5,POS,0",
            ],
        )
        assert parse_dye_channels(path) == ["FAM", "HEX", "CY5"]

    def test_strips_whitespace(self, tmp_path: Path) -> None:
        path = _write_csv(
            tmp_path,
            "Well,Sample,Target,Fluorescence,Function,Cq",
            ["A1,S1,Ch1, ORANGE 560 ,POS,0"],
        )
        assert parse_dye_channels(path) == ["ORANGE 560"]


# ---------------------------------------------------------------------------
# Validation / error tests
# ---------------------------------------------------------------------------


class TestParseDyeChannelsValidation:
    def test_missing_fluorescence_column(self, tmp_path: Path) -> None:
        path = _write_csv(
            tmp_path,
            "Well,Sample,Target,Dye,Function,Cq",
            ["A1,S1,Ch1,FAM,POS,0"],
        )
        with pytest.raises(ValueError, match="missing the required 'Fluorescence' column"):
            parse_dye_channels(path)

    def test_empty_fluorescence_values(self, tmp_path: Path) -> None:
        path = _write_csv(
            tmp_path,
            "Well,Sample,Target,Fluorescence,Function,Cq",
            ["A1,S1,Ch1,,POS,0", "B1,S1,Ch2,,POS,0"],
        )
        with pytest.raises(ValueError, match="No dye channel values found"):
            parse_dye_channels(path)
