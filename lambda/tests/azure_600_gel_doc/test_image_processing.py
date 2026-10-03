"""`TIFFProcessor.export_figure` writes the PNG where the caller asks."""

from __future__ import annotations
from pathlib import Path

import pytest
from matplotlib.figure import Figure

from data_hub_lambda.azure_600_gel_doc.image_processing import TIFFProcessor


@pytest.fixture
def processor(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TIFFProcessor:
    raw_dir = tmp_path / "raw"
    raw_dir.mkdir()
    gel = TIFFProcessor(raw_dir / "gel.tif")
    monkeypatch.setattr(gel, "generate_figure", lambda: Figure(figsize=(0.1, 0.1)))
    return gel


def test_png_goes_to_the_output_dir_off_a_read_only_mount(
    processor: TIFFProcessor, tmp_path: Path
) -> None:
    output_dir = tmp_path / "processed" / "gel-doc" / "run"

    png = processor.export_figure(output_dir=output_dir)

    assert png == output_dir / "gel.png"
    assert png.is_file()
    assert not (processor.path.parent / "gel.png").exists()


def test_png_defaults_to_the_tiff_folder(processor: TIFFProcessor) -> None:
    png = processor.export_figure()

    assert png == processor.path.parent / "gel.png"
    assert png.is_file()
