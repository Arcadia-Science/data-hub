"""Unit tests for `epson_v700_scanner.image_processing`."""

from __future__ import annotations
from pathlib import Path

import imageio.v3 as iio
import numpy as np
import pytest
import tifffile

from data_hub_lambda.epson_v700_scanner.image_processing import (
    MAX_DIMENSION,
    TIFFToJPEGConverter,
    _derive_color_mode,
    _derive_dpi,
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

        loaded = iio.imread(jpg_path)
        assert loaded.ndim == 3
        assert loaded.shape[2] == 3

    def test_resizes_large_image(self, tmp_path: Path) -> None:
        img = np.random.randint(0, 255, (4000, 6000, 3), dtype=np.uint8)
        tif_path = _write_tiff(tmp_path / "big.tif", img)

        converter = TIFFToJPEGConverter(tif_path)
        converter.load()
        jpg_path = converter.export_jpg()

        loaded = iio.imread(jpg_path)
        assert max(loaded.shape[:2]) <= MAX_DIMENSION

    def test_does_not_upscale_small_image(self, tmp_path: Path) -> None:
        img = np.random.randint(0, 255, (100, 150, 3), dtype=np.uint8)
        tif_path = _write_tiff(tmp_path / "small.tif", img)

        converter = TIFFToJPEGConverter(tif_path)
        converter.load()
        jpg_path = converter.export_jpg()

        loaded = iio.imread(jpg_path)
        assert loaded.shape[0] == 100
        assert loaded.shape[1] == 150

    def test_converts_grayscale_to_rgb(self, tmp_path: Path) -> None:
        img = np.random.randint(0, 255, (200, 300), dtype=np.uint8)
        tif_path = _write_tiff(tmp_path / "gray.tif", img)

        converter = TIFFToJPEGConverter(tif_path)
        converter.load()
        jpg_path = converter.export_jpg()

        loaded = iio.imread(jpg_path)
        assert loaded.ndim == 3
        assert loaded.shape[2] == 3

    def test_converts_rgba_to_rgb(self, tmp_path: Path) -> None:
        img = np.random.randint(0, 255, (200, 300, 4), dtype=np.uint8)
        tif_path = _write_tiff(tmp_path / "rgba.tif", img)

        converter = TIFFToJPEGConverter(tif_path)
        converter.load()
        jpg_path = converter.export_jpg()

        loaded = iio.imread(jpg_path)
        assert loaded.ndim == 3
        assert loaded.shape[2] == 3

    def test_handles_16bit_input(self, tmp_path: Path) -> None:
        img = np.random.randint(0, 65535, (200, 300, 3), dtype=np.uint16)
        tif_path = _write_tiff(tmp_path / "16bit.tif", img)

        converter = TIFFToJPEGConverter(tif_path)
        converter.load()
        jpg_path = converter.export_jpg()

        loaded = iio.imread(jpg_path)
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


class TestDeriveDpi:
    def test_returns_300_dpi(self) -> None:
        # 300 dpi = 300 * 2^22 / 2^22; the V700 stores it as 1258291200/4194304
        assert _derive_dpi([1258291200, 4194304]) == 300

    def test_returns_600_dpi(self) -> None:
        assert _derive_dpi([1258291200, 2097152]) == 600

    def test_handles_tuple(self) -> None:
        assert _derive_dpi((600, 1)) == 600

    def test_returns_none_for_missing(self) -> None:
        assert _derive_dpi(None) is None

    def test_returns_none_for_zero_denominator(self) -> None:
        assert _derive_dpi([300, 0]) is None

    def test_returns_none_for_malformed(self) -> None:
        assert _derive_dpi([300]) is None
        assert _derive_dpi("not a list") is None


class TestDeriveColorMode:
    def test_samples_per_pixel_3_is_rgb(self) -> None:
        assert _derive_color_mode(3, None) == "rgb"

    def test_samples_per_pixel_1_is_bw(self) -> None:
        assert _derive_color_mode(1, None) == "bw"

    def test_falls_back_to_photometric_rgb(self) -> None:
        assert _derive_color_mode(None, 2) == "rgb"

    def test_falls_back_to_photometric_bw(self) -> None:
        assert _derive_color_mode(None, 1) == "bw"

    def test_returns_none_when_both_missing(self) -> None:
        assert _derive_color_mode(None, None) is None


class TestParseMetadataDerivedFields:
    def test_emits_dpi_and_rgb_color_mode(self, tmp_path: Path) -> None:
        img = np.random.randint(0, 255, (100, 100, 3), dtype=np.uint8)
        tif_path = tmp_path / "scan.tif"
        tifffile.imwrite(str(tif_path), img, resolution=(300, 300))

        converter = TIFFToJPEGConverter(tif_path)
        converter.load()
        metadata = converter.parse_metadata()

        assert metadata["dpi"] == 300
        assert metadata["color_mode"] == "rgb"

    def test_emits_bw_color_mode_for_grayscale(self, tmp_path: Path) -> None:
        img = np.random.randint(0, 255, (100, 100), dtype=np.uint8)
        tif_path = tmp_path / "gray.tif"
        tifffile.imwrite(str(tif_path), img, resolution=(600, 600))

        converter = TIFFToJPEGConverter(tif_path)
        converter.load()
        metadata = converter.parse_metadata()

        assert metadata["dpi"] == 600
        assert metadata["color_mode"] == "bw"


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
