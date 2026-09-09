"""Unit tests for Azure Cielo native `.AZE` project parsing and dispatch."""

from __future__ import annotations
import json
import struct
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from data_hub_lambda.azure_cielo_qpcr.aze import is_aze_filename, parse_aze_file
from data_hub_lambda.azure_cielo_qpcr.process_file import process_file
from data_hub_lambda.models import FileResponse


def _segment(payload: bytes) -> bytes:
    return struct.pack(">I", len(payload)) + payload


def _well_infos(rows: int = 8, cols: int = 12) -> list[list[dict[str, Any]]]:
    return [
        [
            {
                "Id": {"Name": f"{chr(ord('A') + r)}{c + 1}"},
                "Pos": {"Row": r, "Col": c, "Id": r * cols + c},
            }
            for c in range(cols)
        ]
        for r in range(rows)
    ]


def _build_aze(
    *,
    melt_channels: dict[int, list[float]] | None = None,
    temper: list[int] | None = None,
    empty_data_segment: bool = False,
    plate: dict[str, Any] | None = None,
) -> bytes:
    """Assemble a minimal .AZE in memory, mirroring the vendor segment order."""
    metadata = json.dumps({"Experiment Version": 1, "Experiment Data Name": "test-run"}).encode()
    plate_json = json.dumps(
        plate if plate is not None else {"NumberOfWells": 96, "WellInfos": _well_infos()}
    ).encode()
    analysis = json.dumps({"IsNormalized": False}).encode()
    if empty_data_segment:
        data_payload = b""
    else:
        data_json: dict[str, Any] = {
            "Device id:": "TEST-01",
            "Device name:": "AZURE CIELO 6",
            "Gain:": 10,
            "Run start time:": "2026-01-01_10:00:00",
            "Run end time:": "2026-01-01_11:00:00",
            "Channel 1expose time": 50,
            "Channel 2expose time": 200,
        }
        if temper is not None:
            data_json["MeltCurveTemper"] = temper
        for channel, values in (melt_channels or {}).items():
            data_json[f"MeltCurveChannel{channel}"] = values
        # Real data segments open with a binary `Azure Data` header and close
        # with zero padding around the pretty-printed JSON.
        data_payload = (
            b"\x00\x00\x00\x0bAzure Data\x00"
            + bytes(32)
            + json.dumps(data_json, indent=1).encode()
            + bytes(64)
        )
    return b"".join(
        [
            _segment(b"Azure qPCR Project"),
            _segment(metadata),
            _segment(bytes(2048)),
            _segment(plate_json),
            _segment(analysis),
            _segment(data_payload),
            _segment(b"[]"),
        ]
    )


def _write_aze(path: Path, **kwargs: Any) -> Path:
    path.write_bytes(_build_aze(**kwargs))
    return path


def test_filename_gate() -> None:
    assert is_aze_filename("Experiment_20260101.AZE")
    assert is_aze_filename("experiment.aze")
    assert not is_aze_filename("Experiment_20260101_MeltingCurve.csv")
    assert not is_aze_filename("experiment.aze.bak")


class TestParseAzeFile:
    def test_melt_channels_reshape_well_major(self, tmp_path: Path) -> None:
        path = _write_aze(
            tmp_path / "run.AZE",
            melt_channels={
                2: [float(i) for i in range(96 * 3)],
                4: [1.0] * 96 * 3,
            },
            temper=[2000, 2050, 2100],
        )
        parsed = parse_aze_file(path)
        assert [b.channel for b in parsed.blocks] == ["Channel2", "Channel4"]
        block = parsed.blocks[0]
        assert len(block.wells) == 96
        assert block.wells["A1"] == [(20.0, 0.0), (20.5, 1.0), (21.0, 2.0)]
        assert block.wells["A2"][0] == (20.0, 3.0)
        assert block.wells["B1"][0] == (20.0, 36.0)
        assert block.wells["H12"][-1] == (21.0, 287.0)

    def test_metadata_and_instrument_info(self, tmp_path: Path) -> None:
        path = _write_aze(tmp_path / "run.AZE")
        parsed = parse_aze_file(path)
        assert parsed.metadata["Experiment Data Name"] == "test-run"
        assert parsed.instrument["device_id"] == "TEST-01"
        assert parsed.instrument["device_name"] == "AZURE CIELO 6"
        assert parsed.instrument["gain"] == 10
        assert parsed.instrument["run_start_time"] == "2026-01-01_10:00:00"
        assert parsed.instrument["channel_exposure_times"] == {
            "channel_1": 50,
            "channel_2": 200,
        }

    def test_setup_only_file_has_no_blocks(self, tmp_path: Path) -> None:
        path = _write_aze(tmp_path / "run.AZE", empty_data_segment=True)
        parsed = parse_aze_file(path)
        assert parsed.blocks == []
        assert parsed.instrument == {}
        assert parsed.metadata["Experiment Data Name"] == "test-run"

    def test_data_segment_without_melt_channels_has_no_blocks(self, tmp_path: Path) -> None:
        path = _write_aze(tmp_path / "run.AZE")
        assert parse_aze_file(path).blocks == []

    def test_bad_magic_raises(self, tmp_path: Path) -> None:
        path = tmp_path / "run.AZE"
        path.write_bytes(_segment(b"Not a project") + _segment(b"{}") * 6)
        with pytest.raises(ValueError, match="Not an Azure Cielo"):
            parse_aze_file(path)

    def test_truncated_file_raises(self, tmp_path: Path) -> None:
        path = tmp_path / "run.AZE"
        path.write_bytes(_build_aze()[:-10])
        with pytest.raises(ValueError, match="Truncated"):
            parse_aze_file(path)

    def test_melt_length_mismatch_raises(self, tmp_path: Path) -> None:
        path = _write_aze(
            tmp_path / "run.AZE",
            melt_channels={2: [1.0] * 10},
            temper=[2000, 2050, 2100],
        )
        with pytest.raises(ValueError, match="not a multiple"):
            parse_aze_file(path)

    def test_missing_temper_raises(self, tmp_path: Path) -> None:
        path = _write_aze(
            tmp_path / "run.AZE",
            melt_channels={2: [1.0] * 96 * 3},
        )
        with pytest.raises(ValueError, match="MeltCurveTemper"):
            parse_aze_file(path)

    def test_well_names_fall_back_to_row_major(self, tmp_path: Path) -> None:
        path = _write_aze(
            tmp_path / "run.AZE",
            melt_channels={2: [float(i) for i in range(96 * 3)]},
            temper=[2000, 2050, 2100],
            plate={"NumberOfWells": 96},
        )
        wells = parse_aze_file(path).blocks[0].wells
        assert len(wells) == 96
        assert wells["A1"][0] == (20.0, 0.0)
        assert wells["B1"][0] == (20.0, 36.0)
        assert wells["H12"][-1] == (21.0, 287.0)

    def test_unsupported_well_count_raises(self, tmp_path: Path) -> None:
        path = _write_aze(
            tmp_path / "run.AZE",
            melt_channels={2: [1.0] * 15},
            temper=[2000, 2050, 2100],
            plate={},
        )
        with pytest.raises(ValueError, match="Unsupported .AZE well count: 5"):
            parse_aze_file(path)


class TestProcessFileAze:
    @pytest.fixture(autouse=True)
    def _reset_api_client(self) -> Any:
        import data_hub_lambda.api_client as api_module

        original = api_module._client
        api_module._client = None
        try:
            yield
        finally:
            api_module._client = original

    def _client(self) -> MagicMock:
        client = MagicMock()
        client.create_file.return_value = FileResponse(
            id=10,
            instrument_run_id="run-uuid",
            filename="file.aze",
            s3_bucket="raw",
            s3_key="azure-cielo-qpcr/Experiment_20260101/file.aze",
            category="raw",
            status="uploaded",
        )
        return client

    def _download(self, payload: bytes) -> Any:
        def _write(s3_uri: str, local_path: Path, **_: Any) -> None:
            local_path.parent.mkdir(parents=True, exist_ok=True)
            local_path.write_bytes(payload)

        return _write

    def _statuses(self, client: MagicMock) -> list[str]:
        return [
            call.kwargs["status"]
            for call in client.update_file.call_args_list
            if "status" in call.kwargs
        ]

    def _processed_filenames(self, client: MagicMock) -> list[str]:
        return [
            call.kwargs["filename"]
            for call in client.create_file.call_args_list
            if call.kwargs.get("category") == "processed"
        ]

    def test_aze_uploads_artifacts(self, tmp_path: Path) -> None:
        client = self._client()
        payload = _build_aze(
            melt_channels={2: [float(i) for i in range(96 * 3)]},
            temper=[2000, 2050, 2100],
        )
        with (
            patch(
                "data_hub_lambda.azure_cielo_qpcr.process_file.get_client",
                return_value=client,
            ),
            patch(
                "data_hub_lambda.azure_cielo_qpcr.process_file.s3_utils.download_file",
                side_effect=self._download(payload),
            ),
            patch("data_hub_lambda.azure_cielo_qpcr.process_file.s3_utils.upload_file"),
            patch(
                "data_hub_shared.config.config.LOCAL_PROCESSED_DATA_DIRPATH",
                tmp_path / "processed",
            ),
        ):
            process_file("azure-cielo-qpcr", "Experiment_20260101", "Experiment_20260101.AZE")

        assert self._processed_filenames(client) == [
            "Experiment_20260101_aze_melting_curve_derivatives.csv",
            "Experiment_20260101_aze_melting_curve_plate.json",
            "Experiment_20260101_aze_experiment.json",
        ]
        assert "failed" not in self._statuses(client)
        assert self._statuses(client)[-1] == "completed"
        client.update_run.assert_not_called()

        run_dir = tmp_path / "processed" / "azure-cielo-qpcr" / "Experiment_20260101"
        plate = json.loads(
            (run_dir / "Experiment_20260101_aze_melting_curve_plate.json").read_text()
        )
        assert [c["channel"] for c in plate["channels"]] == ["Channel2"]
        assert len(plate["channels"][0]["wells"]) == 96
        sidecar = json.loads((run_dir / "Experiment_20260101_aze_experiment.json").read_text())
        assert sidecar["metadata"]["Experiment Data Name"] == "test-run"
        assert sidecar["instrument"]["device_id"] == "TEST-01"

    def test_setup_only_aze_completes_without_artifacts(self, tmp_path: Path) -> None:
        client = self._client()
        with (
            patch(
                "data_hub_lambda.azure_cielo_qpcr.process_file.get_client",
                return_value=client,
            ),
            patch(
                "data_hub_lambda.azure_cielo_qpcr.process_file.s3_utils.download_file",
                side_effect=self._download(_build_aze(empty_data_segment=True)),
            ),
            patch("data_hub_lambda.azure_cielo_qpcr.process_file.s3_utils.upload_file"),
            patch(
                "data_hub_shared.config.config.LOCAL_PROCESSED_DATA_DIRPATH",
                tmp_path / "processed",
            ),
        ):
            process_file("azure-cielo-qpcr", "Experiment_20260101", "Experiment_20260101.AZE")

        assert self._processed_filenames(client) == []
        assert self._statuses(client)[-1] == "completed"
        client.update_run.assert_not_called()

    def test_corrupt_aze_fails(self, tmp_path: Path) -> None:
        client = self._client()
        with (
            patch(
                "data_hub_lambda.azure_cielo_qpcr.process_file.get_client",
                return_value=client,
            ),
            patch(
                "data_hub_lambda.azure_cielo_qpcr.process_file.s3_utils.download_file",
                side_effect=self._download(b"not an aze file"),
            ),
            patch(
                "data_hub_shared.config.config.LOCAL_PROCESSED_DATA_DIRPATH",
                tmp_path / "processed",
            ),
            pytest.raises(ValueError),
        ):
            process_file("azure-cielo-qpcr", "Experiment_20260101", "Experiment_20260101.AZE")

        assert self._statuses(client)[-1] == "failed"
