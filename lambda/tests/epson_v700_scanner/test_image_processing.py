"""Unit tests for `epson_v700_scanner.image_processing`."""

from __future__ import annotations
from pathlib import Path

import numpy as np
import pytest
import skimage as ski
import tifffile

from data_hub_lambda.epson_v700_scanner.image_processing import (
    MAX_DIMENSION,
    TIFFToJPEGConverter,
)


def _write_tiff(path: Path, img: np.ndarray) -> Path:  # type: ignore[type-arg]
    tifffile.imwrite(str(path), img)
    return path


class TestExportJpg:
    def test_produces_valid_jpeg(self, tmp_path: Path) -> None:
        img = np.random.randint(0, 255, (200, 300, 3), dtype=np.uint8)
        tif_path = _write_tiff(tmp_path / "scan.tif", img)

        converter = TIFFToJPEGConverter(tif_path)
        converter.load()
        jpg_path = converter.export_jpg()

        assert jpg_path.exists()
        assert jpg_path.suffix == ".jpg"

        loaded = ski.io.imread(str(jpg_path))
        assert loaded.ndim == 3
        assert loaded.shape[2] == 3

    def test_resizes_large_image(self, tmp_path: Path) -> None:
        img = np.random.randint(0, 255, (4000, 6000, 3), dtype=np.uint8)
        tif_path = _write_tiff(tmp_path / "big.tif", img)

        converter = TIFFToJPEGConverter(tif_path)
        converter.load()
        jpg_path = converter.export_jpg()

        loaded = ski.io.imread(str(jpg_path))
        assert max(loaded.shape[:2]) <= MAX_DIMENSION

    def test_does_not_upscale_small_image(self, tmp_path: Path) -> None:
        img = np.random.randint(0, 255, (100, 150, 3), dtype=np.uint8)
        tif_path = _write_tiff(tmp_path / "small.tif", img)

        converter = TIFFToJPEGConverter(tif_path)
        converter.load()
        jpg_path = converter.export_jpg()

        loaded = ski.io.imread(str(jpg_path))
        assert loaded.shape[0] == 100
        assert loaded.shape[1] == 150

    def test_converts_grayscale_to_rgb(self, tmp_path: Path) -> None:
        img = np.random.randint(0, 255, (200, 300), dtype=np.uint8)
        tif_path = _write_tiff(tmp_path / "gray.tif", img)

        converter = TIFFToJPEGConverter(tif_path)
        converter.load()
        jpg_path = converter.export_jpg()

        loaded = ski.io.imread(str(jpg_path))
        assert loaded.ndim == 3
        assert loaded.shape[2] == 3

    def test_converts_rgba_to_rgb(self, tmp_path: Path) -> None:
        img = np.random.randint(0, 255, (200, 300, 4), dtype=np.uint8)
        tif_path = _write_tiff(tmp_path / "rgba.tif", img)

        converter = TIFFToJPEGConverter(tif_path)
        converter.load()
        jpg_path = converter.export_jpg()

        loaded = ski.io.imread(str(jpg_path))
        assert loaded.ndim == 3
        assert loaded.shape[2] == 3

    def test_handles_16bit_input(self, tmp_path: Path) -> None:
        img = np.random.randint(0, 65535, (200, 300, 3), dtype=np.uint16)
        tif_path = _write_tiff(tmp_path / "16bit.tif", img)

        converter = TIFFToJPEGConverter(tif_path)
        converter.load()
        jpg_path = converter.export_jpg()

        loaded = ski.io.imread(str(jpg_path))
        assert loaded.dtype == np.uint8


class TestParseMetadata:
    def test_returns_original_dimensions(self, tmp_path: Path) -> None:
        img = np.random.randint(0, 255, (480, 640, 3), dtype=np.uint8)
        tif_path = _write_tiff(tmp_path / "scan.tif", img)

        converter = TIFFToJPEGConverter(tif_path)
        converter.load()
        metadata = converter.parse_metadata()

        assert metadata["OriginalHeight"] == 480
        assert metadata["OriginalWidth"] == 640

    def test_returns_standard_tiff_tags(self, tmp_path: Path) -> None:
        img = np.random.randint(0, 255, (100, 200, 3), dtype=np.uint8)
        tif_path = _write_tiff(tmp_path / "scan.tif", img)

        converter = TIFFToJPEGConverter(tif_path)
        converter.load()
        metadata = converter.parse_metadata()

        assert "ImageWidth" in metadata
        assert "ImageLength" in metadata
        assert "BitsPerSample" in metadata


class TestValidation:
    def test_rejects_missing_file(self, tmp_path: Path) -> None:
        converter = TIFFToJPEGConverter(tmp_path / "nonexistent.tif")
        with pytest.raises(FileNotFoundError):
            converter.load()

    def test_rejects_non_tiff_extension(self, tmp_path: Path) -> None:
        path = tmp_path / "scan.png"
        path.write_bytes(b"fake")
        converter = TIFFToJPEGConverter(path)
        with pytest.raises(ValueError, match="Expected TIFF file"):
            converter.load()
