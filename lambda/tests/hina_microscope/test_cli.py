"""The `hina` CLI command writes its JPG, and an MP4 for a timelapse, into `--output-dir`."""

from __future__ import annotations
from pathlib import Path
from unittest.mock import MagicMock, patch

from click.testing import CliRunner, Result

from data_hub_lambda.cli import cli
from data_hub_lambda.hina_microscope.image_processing import TimelapseVideo


def _invoke(tmp_path: Path, processor: MagicMock) -> Result:
    nd2_file = tmp_path / "sample.nd2"
    nd2_file.write_bytes(b"nd2")
    with (
        patch(
            "data_hub_lambda.hina_microscope.image_processing.ND2Processor",
            return_value=processor,
        ),
        patch(
            "data_hub_lambda.hina_microscope.parse_metadata.parse_metadata",
            return_value={"sizes": {}},
        ),
    ):
        return CliRunner().invoke(
            cli, ["hina", str(nd2_file), "--output-dir", str(tmp_path / "out")]
        )


def test_output_dir_is_passed_to_the_exporter(tmp_path: Path) -> None:
    output_dir = tmp_path / "out"
    processor = MagicMock()
    processor.export_jpg.return_value = output_dir / "sample.jpg"
    processor.export_mp4.return_value = None

    result = _invoke(tmp_path, processor)

    assert result.exit_code == 0, result.output
    processor.export_jpg.assert_called_once_with(output_dir=output_dir)
    processor.export_mp4.assert_called_once_with(output_dir=output_dir)
    assert f"Exported JPG: {output_dir / 'sample.jpg'}" in result.output
    assert "Exported MP4" not in result.output


def test_timelapse_also_reports_its_mp4(tmp_path: Path) -> None:
    mp4 = tmp_path / "out" / "sample.mp4"
    processor = MagicMock()
    processor.export_jpg.return_value = tmp_path / "out" / "sample.jpg"
    processor.export_mp4.return_value = TimelapseVideo(
        path=mp4, frames=53, frame_interval_ms=500.16, playback_fps=10.0
    )

    result = _invoke(tmp_path, processor)

    assert result.exit_code == 0, result.output
    assert f"Exported MP4: {mp4} (53 frames at 10 fps)" in result.output
