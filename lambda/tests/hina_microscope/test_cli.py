"""The `hina` CLI command writes its JPG straight into `--output-dir`."""

from __future__ import annotations
from pathlib import Path
from unittest.mock import MagicMock, patch

from click.testing import CliRunner

from data_hub_lambda.cli import cli


def test_output_dir_is_passed_to_the_exporter(tmp_path: Path) -> None:
    nd2_file = tmp_path / "sample.nd2"
    nd2_file.write_bytes(b"nd2")
    output_dir = tmp_path / "out"
    processor = MagicMock()
    processor.export_jpg.return_value = output_dir / "sample.jpg"

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
        result = CliRunner().invoke(cli, ["hina", str(nd2_file), "--output-dir", str(output_dir)])

    assert result.exit_code == 0, result.output
    processor.export_jpg.assert_called_once_with(output_dir=output_dir)
    assert f"Exported JPG: {output_dir / 'sample.jpg'}" in result.output
