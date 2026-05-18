"""Unit tests for `epson_v700_scanner.image_processing`."""

from __future__ import annotations
from pathlib import Path

import imageio.v3 as iio
import numpy as np
import pytest
import tifffile

from data_hub_lambda.epson_v700_scanner.image_processing import (
    MAX_DIMENSION,
    TiffProcessor,
    _derive_color_mode,
    _derive_dpi,
)

_GOLD_RGB = np.array([200, 170, 40], dtype=np.uint8)


def _write_tiff(path: Path, img: np.ndarray) -> Path:  # type: ignore[type-arg]
    tifffile.imwrite(str(path), img)
    return path


class TestExportJpg:
    def test_produces_valid_jpeg(self, tmp_path: Path) -> None:
        img = np.random.randint(0, 255, (200, 300, 3), dtype=np.uint8)
        tif_path = _write_tiff(tmp_path / "scan.tif", img)

        converter = TiffProcessor(tif_path)
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

        converter = TiffProcessor(tif_path)
        converter.load()
        jpg_path = converter.export_jpg()

        loaded = iio.imread(jpg_path)
        assert max(loaded.shape[:2]) <= MAX_DIMENSION

    def test_does_not_upscale_small_image(self, tmp_path: Path) -> None:
        img = np.random.randint(0, 255, (100, 150, 3), dtype=np.uint8)
        tif_path = _write_tiff(tmp_path / "small.tif", img)

        converter = TiffProcessor(tif_path)
        converter.load()
        jpg_path = converter.export_jpg()

        loaded = iio.imread(jpg_path)
        assert loaded.shape[0] == 100
        assert loaded.shape[1] == 150

    def test_converts_grayscale_to_rgb(self, tmp_path: Path) -> None:
        img = np.random.randint(0, 255, (200, 300), dtype=np.uint8)
        tif_path = _write_tiff(tmp_path / "gray.tif", img)

        converter = TiffProcessor(tif_path)
        converter.load()
        jpg_path = converter.export_jpg()

        loaded = iio.imread(jpg_path)
        assert loaded.ndim == 3
        assert loaded.shape[2] == 3

    def test_converts_rgba_to_rgb(self, tmp_path: Path) -> None:
        img = np.random.randint(0, 255, (200, 300, 4), dtype=np.uint8)
        tif_path = _write_tiff(tmp_path / "rgba.tif", img)

        converter = TiffProcessor(tif_path)
        converter.load()
        jpg_path = converter.export_jpg()

        loaded = iio.imread(jpg_path)
        assert loaded.ndim == 3
        assert loaded.shape[2] == 3

    def test_handles_16bit_input(self, tmp_path: Path) -> None:
        img = np.random.randint(0, 65535, (200, 300, 3), dtype=np.uint16)
        tif_path = _write_tiff(tmp_path / "16bit.tif", img)

        converter = TiffProcessor(tif_path)
        converter.load()
        jpg_path = converter.export_jpg()

        loaded = iio.imread(jpg_path)
        assert loaded.dtype == np.uint8


class TestParseMetadata:
    def test_returns_original_dimensions(self, tmp_path: Path) -> None:
        img = np.random.randint(0, 255, (480, 640, 3), dtype=np.uint8)
        tif_path = _write_tiff(tmp_path / "scan.tif", img)

        converter = TiffProcessor(tif_path)
        converter.load()
        metadata = converter.parse_metadata()

        assert metadata["OriginalHeight"] == 480
        assert metadata["OriginalWidth"] == 640

    def test_returns_standard_tiff_tags(self, tmp_path: Path) -> None:
        img = np.random.randint(0, 255, (100, 200, 3), dtype=np.uint8)
        tif_path = _write_tiff(tmp_path / "scan.tif", img)

        converter = TiffProcessor(tif_path)
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

        converter = TiffProcessor(tif_path)
        converter.load()
        metadata = converter.parse_metadata()

        assert metadata["dpi"] == 300
        assert metadata["color_mode"] == "rgb"

    def test_emits_bw_color_mode_for_grayscale(self, tmp_path: Path) -> None:
        img = np.random.randint(0, 255, (100, 100), dtype=np.uint8)
        tif_path = tmp_path / "gray.tif"
        tifffile.imwrite(str(tif_path), img, resolution=(600, 600))

        converter = TiffProcessor(tif_path)
        converter.load()
        metadata = converter.parse_metadata()

        assert metadata["dpi"] == 600
        assert metadata["color_mode"] == "bw"


class TestValidation:
    def test_rejects_missing_file(self, tmp_path: Path) -> None:
        converter = TiffProcessor(tmp_path / "nonexistent.tif")
        with pytest.raises(FileNotFoundError):
            converter.load()

    def test_rejects_non_tiff_extension(self, tmp_path: Path) -> None:
        path = tmp_path / "scan.png"
        path.write_bytes(b"fake")
        converter = TiffProcessor(path)
        with pytest.raises(ValueError, match="Expected TIFF file"):
            converter.load()


# ------------------------------------------------------------------
# Plate detection
# ------------------------------------------------------------------


def _make_gold_frame(
    canvas_h: int,
    canvas_w: int,
    top: int,
    left: int,
    bottom: int,
    right: int,
    thickness: int = 20,
) -> np.ndarray:  # type: ignore[type-arg]
    """Paint a gold rectangular frame on a black canvas and return it."""
    img = np.zeros((canvas_h, canvas_w, 3), dtype=np.uint8)
    img[top : top + thickness, left:right] = _GOLD_RGB
    img[bottom - thickness : bottom, left:right] = _GOLD_RGB
    img[top:bottom, left : left + thickness] = _GOLD_RGB
    img[top:bottom, right - thickness : right] = _GOLD_RGB
    return img


class TestDetectPlates:
    def test_single_gold_frame(self) -> None:
        img = _make_gold_frame(500, 400, top=50, left=50, bottom=350, right=350)
        proc = TiffProcessor(Path("dummy.tif"))
        proc.detect_plates(img)

        assert proc.plate_boxes is not None
        assert len(proc.plate_boxes) == 1
        min_row, min_col, max_row, max_col = proc.plate_boxes[0]
        assert 60 < min_row < 80
        assert 60 < min_col < 80
        assert 320 < max_row < 340
        assert 320 < max_col < 340

    def test_two_gold_frames_sorted_left_to_right(self) -> None:
        img = np.zeros((500, 800, 3), dtype=np.uint8)
        frame1 = _make_gold_frame(500, 800, top=50, left=50, bottom=350, right=300)
        frame2 = _make_gold_frame(500, 800, top=50, left=400, bottom=350, right=700)
        img = np.maximum(img, np.maximum(frame1, frame2))

        proc = TiffProcessor(Path("dummy.tif"))
        proc.detect_plates(img)

        assert proc.plate_boxes is not None
        assert len(proc.plate_boxes) == 2
        assert proc.plate_boxes[0][1] < proc.plate_boxes[1][1]

    def test_no_gold_returns_empty(self) -> None:
        img = np.random.randint(0, 50, (400, 400, 3), dtype=np.uint8)
        proc = TiffProcessor(Path("dummy.tif"))
        proc.detect_plates(img)
        assert proc.plate_boxes == []

    def test_metadata_includes_plate_count(self, tmp_path: Path) -> None:
        img = _make_gold_frame(500, 400, top=50, left=50, bottom=350, right=350)
        tif_path = tmp_path / "framed.tif"
        tifffile.imwrite(str(tif_path), img)

        proc = TiffProcessor(tif_path)
        proc.load()
        proc.export_jpg()
        metadata = proc.parse_metadata()

        assert metadata["plate_count"] == 1
        assert len(metadata["plate_boxes"]) == 1


class TestDrawPlateOverlays:
    def test_shape_and_dtype_preserved(self) -> None:
        img = np.random.randint(0, 255, (200, 300, 3), dtype=np.uint8)
        boxes = [(50, 50, 150, 250)]
        result = TiffProcessor._draw_plate_overlays(img, boxes)
        assert result.shape == img.shape
        assert result.dtype == np.uint8

    def test_interior_pixels_unchanged(self) -> None:
        img = np.full((200, 300, 3), 128, dtype=np.uint8)
        boxes = [(50, 50, 150, 250)]
        result = TiffProcessor._draw_plate_overlays(img, boxes)
        np.testing.assert_array_equal(result[50:150, 50:250], img[50:150, 50:250])

    def test_border_pixels_modified(self) -> None:
        img = np.full((200, 300, 3), 128, dtype=np.uint8)
        boxes = [(50, 50, 150, 250)]
        result = TiffProcessor._draw_plate_overlays(img, boxes)
        assert not np.array_equal(result[42:50, 50:250], img[42:50, 50:250])


class TestDrawColonyBboxes:
    def test_shape_and_dtype_preserved(self) -> None:
        from data_hub_lambda.epson_v700_scanner.colony_detection import (
            ColonyDetectionResult,
            ColonyProperties,
        )

        img = np.random.randint(0, 255, (400, 400, 3), dtype=np.uint8)
        boxes = [(50, 50, 350, 350)]
        colony = ColonyProperties(
            label=1,
            area_mm2=1.0,
            centroid_row_mm=5.0,
            centroid_col_mm=5.0,
            bbox_mm=(4.0, 4.0, 6.0, 6.0),
            eccentricity=0.0,
            equivalent_diameter_mm=1.13,
            mean_rgb=(128.0, 128.0, 128.0),
        )
        result_obj = ColonyDetectionResult(
            cropped=img[50:350, 50:350],
            contrast=np.zeros((300, 300)),
            has_colonies=True,
            mask=np.zeros((300, 300), dtype=bool),
            colonies=[colony],
        )
        result = TiffProcessor._draw_colony_bboxes(img, boxes, [result_obj], dpi=600)
        assert result.shape == img.shape
        assert result.dtype == np.uint8
