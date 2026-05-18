"""Unit tests for `epson_v700_scanner.colony_detection`."""

from __future__ import annotations
from pathlib import Path

import numpy as np
import pandas as pd

from data_hub_lambda.epson_v700_scanner.colony_detection import (
    MARGIN_PX,
    ColonyDetectionResult,
    ColonyProperties,
    crop_margin,
    detect_colonies,
    detect_colony_presence,
    export_colony_csv,
    measure_colonies,
    optimize_colony_contrast,
    smooth,
    threshold_colonies,
)


def _uniform_plate(h: int = 1000, w: int = 1000, value: int = 120) -> np.ndarray:  # type: ignore[type-arg]
    """Create a uniform-colour plate image (no colonies)."""
    return np.full((h, w, 3), value, dtype=np.uint8)


def _plate_with_colonies(
    h: int = 1000,
    w: int = 1000,
    bg: int = 120,
    colony_color: tuple[int, int, int] = (255, 255, 255),
    n_colonies: int = 3,
    colony_radius: int = 15,
) -> np.ndarray:  # type: ignore[type-arg]
    """Create a synthetic plate with circular colonies inside the margin."""
    img = np.full((h, w, 3), bg, dtype=np.uint8)
    rng = np.random.RandomState(42)
    margin = MARGIN_PX + colony_radius + 5
    for _ in range(n_colonies):
        cy = rng.randint(margin, h - margin)
        cx = rng.randint(margin, w - margin)
        rr, cc = _disk(cy, cx, colony_radius, h, w)
        img[rr, cc] = colony_color
    return img


def _disk(cy: int, cx: int, radius: int, h: int, w: int) -> tuple[np.ndarray, np.ndarray]:  # type: ignore[type-arg]
    """Return row, col arrays for a filled circle clipped to (h, w)."""
    Y, X = np.ogrid[:h, :w]
    mask = (Y - cy) ** 2 + (X - cx) ** 2 <= radius**2
    rows, cols = np.where(mask)
    return rows, cols


# ------------------------------------------------------------------
# crop_margin
# ------------------------------------------------------------------


class TestCropMargin:
    def test_default_removes_margin(self) -> None:
        img = np.zeros((1000, 1200, 3), dtype=np.uint8)
        cropped = crop_margin(img)
        assert cropped.shape == (1000 - 2 * MARGIN_PX, 1200 - 2 * MARGIN_PX, 3)

    def test_grayscale(self) -> None:
        img = np.zeros((1000, 1000), dtype=np.uint8)
        cropped = crop_margin(img)
        assert cropped.shape == (1000 - 2 * MARGIN_PX, 1000 - 2 * MARGIN_PX)

    def test_custom_margin(self) -> None:
        img = np.zeros((200, 200, 3), dtype=np.uint8)
        cropped = crop_margin(img, margin_px=50)
        assert cropped.shape == (100, 100, 3)

    def test_preserves_content(self) -> None:
        img = np.arange(500 * 500, dtype=np.uint8).reshape(500, 500)
        cropped = crop_margin(img, margin_px=20)
        np.testing.assert_array_equal(cropped, img[20:480, 20:480])


# ------------------------------------------------------------------
# optimize_colony_contrast
# ------------------------------------------------------------------


class TestOptimizeColonyContrast:
    def test_grayscale_passthrough(self) -> None:
        img = np.random.randint(0, 255, (50, 50), dtype=np.uint8)
        result = optimize_colony_contrast(img)
        assert result.shape == (50, 50)
        assert result.dtype == np.float64

    def test_uniform_rgb_gives_near_zero(self) -> None:
        img = np.full((50, 50, 3), 128, dtype=np.uint8)
        result = optimize_colony_contrast(img)
        assert result.max() < 1.0

    def test_colony_pixels_are_bright(self) -> None:
        img = np.full((100, 100, 3), 80, dtype=np.uint8)
        img[40:60, 40:60] = [220, 220, 220]
        result = optimize_colony_contrast(img)
        colony_region = result[40:60, 40:60]
        bg_region = result[0:20, 0:20]
        assert colony_region.mean() > bg_region.mean()

    def test_zero_pixels_stay_zero(self) -> None:
        img = np.full((50, 50, 3), 100, dtype=np.uint8)
        img[0:10, :] = 0
        result = optimize_colony_contrast(img)
        np.testing.assert_array_equal(result[0:10, :], 0)


# ------------------------------------------------------------------
# detect_colony_presence
# ------------------------------------------------------------------


class TestDetectColonyPresence:
    def test_uniform_returns_false(self) -> None:
        contrast = np.full((100, 100), 1.0)
        assert detect_colony_presence(contrast) is False

    def test_high_contrast_returns_true(self) -> None:
        contrast = np.zeros((100, 100))
        contrast[30:70, 30:70] = 50.0
        assert detect_colony_presence(contrast) is True

    def test_custom_threshold(self) -> None:
        contrast = np.full((100, 100), 3.0)
        assert detect_colony_presence(contrast, threshold=2.0) is True
        assert detect_colony_presence(contrast, threshold=4.0) is False


# ------------------------------------------------------------------
# smooth
# ------------------------------------------------------------------


class TestSmooth:
    def test_output_shape_preserved(self) -> None:
        img = np.random.rand(100, 100)
        result = smooth(img)
        assert result.shape == img.shape

    def test_smoothing_reduces_noise(self) -> None:
        rng = np.random.RandomState(0)
        img = rng.rand(200, 200) * 100
        result = smooth(img, low_sigma=0.6, high_sigma=64.0)
        assert result.std() < img.std()

    def test_result_is_non_negative(self) -> None:
        rng = np.random.RandomState(42)
        img = rng.rand(200, 200) * 100
        result = smooth(img)
        assert np.all(result >= 0)


# ------------------------------------------------------------------
# threshold_colonies
# ------------------------------------------------------------------


class TestThresholdColonies:
    def test_returns_bool_mask(self) -> None:
        img = np.random.rand(100, 100)
        mask = threshold_colonies(img)
        assert mask.dtype == np.bool_
        assert mask.shape == img.shape

    def test_bimodal_separation(self) -> None:
        img = np.zeros((100, 100), dtype=np.float64)
        img[30:70, 30:70] = 100.0
        mask = threshold_colonies(img)
        assert mask[50, 50]
        assert not mask[0, 0]


# ------------------------------------------------------------------
# measure_colonies
# ------------------------------------------------------------------


_TEST_DPI = 1200


class TestMeasureColonies:
    def test_empty_mask_returns_empty(self) -> None:
        mask = np.zeros((100, 100), dtype=bool)
        rgb = np.zeros((100, 100, 3), dtype=np.uint8)
        colonies, cleaned = measure_colonies(mask, rgb, dpi=_TEST_DPI)
        assert colonies == []
        assert not cleaned.any()

    def test_single_blob(self) -> None:
        mask = np.zeros((100, 100), dtype=bool)
        mask[40:60, 40:60] = True
        rgb = np.full((100, 100, 3), 128, dtype=np.uint8)
        colonies, _ = measure_colonies(mask, rgb, dpi=_TEST_DPI)
        assert len(colonies) == 1
        mm_per_px = 25.4 / _TEST_DPI
        expected_area_mm2 = 20 * 20 * mm_per_px**2
        assert abs(colonies[0].area_mm2 - expected_area_mm2) < 1e-6

    def test_two_blobs_sorted_by_area(self) -> None:
        mask = np.zeros((200, 200), dtype=bool)
        mask[10:22, 10:22] = True  # 144 px (above min-area threshold at 1200 DPI)
        mask[50:80, 50:80] = True  # 900 px
        rgb = np.full((200, 200, 3), 128, dtype=np.uint8)
        colonies, _ = measure_colonies(mask, rgb, dpi=_TEST_DPI)
        assert len(colonies) == 2
        assert colonies[0].area_mm2 > colonies[1].area_mm2

    def test_colony_properties_populated(self) -> None:
        mask = np.zeros((100, 100), dtype=bool)
        mask[40:60, 40:60] = True
        rgb = np.full((100, 100, 3), 128, dtype=np.uint8)
        colonies, _ = measure_colonies(mask, rgb, dpi=_TEST_DPI)
        colony = colonies[0]
        assert isinstance(colony, ColonyProperties)
        assert colony.label >= 1
        assert colony.eccentricity >= 0.0
        assert colony.equivalent_diameter_mm > 0.0
        assert len(colony.bbox_mm) == 4

    def test_centroid_includes_margin_offset(self) -> None:
        mask = np.zeros((100, 100), dtype=bool)
        mask[40:60, 40:60] = True
        rgb = np.full((100, 100, 3), 128, dtype=np.uint8)
        mm_per_px = 25.4 / _TEST_DPI
        colonies, _ = measure_colonies(mask, rgb, dpi=_TEST_DPI, margin_px=MARGIN_PX)
        colony = colonies[0]
        expected_row_mm = (50.0 + MARGIN_PX) * mm_per_px
        expected_col_mm = (50.0 + MARGIN_PX) * mm_per_px
        assert abs(colony.centroid_row_mm - expected_row_mm) < 0.1
        assert abs(colony.centroid_col_mm - expected_col_mm) < 0.1

    def test_mean_rgb_populated(self) -> None:
        mask = np.zeros((100, 100), dtype=bool)
        mask[40:60, 40:60] = True
        rgb = np.zeros((100, 100, 3), dtype=np.uint8)
        rgb[40:60, 40:60] = [200, 100, 50]
        colonies, _ = measure_colonies(mask, rgb, dpi=_TEST_DPI)
        colony = colonies[0]
        assert abs(colony.mean_rgb[0] - 200.0) < 1.0
        assert abs(colony.mean_rgb[1] - 100.0) < 1.0
        assert abs(colony.mean_rgb[2] - 50.0) < 1.0

    def test_border_colonies_excluded(self) -> None:
        mask = np.zeros((100, 100), dtype=bool)
        mask[0:10, 40:60] = True  # touches top border
        mask[40:60, 40:60] = True  # interior
        rgb = np.full((100, 100, 3), 128, dtype=np.uint8)
        colonies, cleaned = measure_colonies(mask, rgb, dpi=_TEST_DPI)
        assert len(colonies) == 1
        assert not cleaned[0:10, 40:60].any()
        assert cleaned[40:60, 40:60].all()


# ------------------------------------------------------------------
# detect_colonies (full pipeline)
# ------------------------------------------------------------------


class TestDetectColonies:
    def test_uniform_plate_no_colonies(self) -> None:
        plate = _uniform_plate()
        result = detect_colonies(plate, dpi=_TEST_DPI)
        assert isinstance(result, ColonyDetectionResult)
        assert result.has_colonies is False
        assert result.colonies == []
        assert result.mask.shape == result.contrast.shape
        assert not result.mask.any()

    def test_plate_with_colonies_detected(self) -> None:
        plate = _plate_with_colonies(colony_color=(255, 255, 255), n_colonies=8, colony_radius=30)
        result = detect_colonies(plate, dpi=_TEST_DPI)
        assert result.has_colonies is True
        assert len(result.colonies) > 0

    def test_summary_schema(self) -> None:
        plate = _plate_with_colonies(n_colonies=2)
        result = detect_colonies(plate, dpi=_TEST_DPI)
        summary = result.summary()
        assert "has_colonies" in summary
        assert "colony_count" in summary
        assert isinstance(summary["colonies"], list)
        if summary["colonies"]:
            c = summary["colonies"][0]
            assert "label" in c
            assert "area_mm2" in c
            assert "centroid_mm" in c
            assert "bbox_mm" in c
            assert "eccentricity" in c
            assert "equivalent_diameter_mm" in c
            assert "mean_rgb" in c

    def test_cropped_smaller_than_input(self) -> None:
        plate = _uniform_plate(1000, 1000)
        result = detect_colonies(plate, dpi=_TEST_DPI)
        assert result.cropped.shape[0] < 1000
        assert result.cropped.shape[1] < 1000

    def test_grayscale_input(self) -> None:
        plate = np.full((1000, 1000), 128, dtype=np.uint8)
        result = detect_colonies(plate, dpi=_TEST_DPI)
        assert isinstance(result, ColonyDetectionResult)


# ------------------------------------------------------------------
# to_dataframe
# ------------------------------------------------------------------


class TestToDataframe:
    def test_columns_present(self) -> None:
        plate = _plate_with_colonies(colony_color=(255, 255, 255), n_colonies=8, colony_radius=30)
        result = detect_colonies(plate, dpi=_TEST_DPI)
        df = result.to_dataframe(plate_index=1)
        assert isinstance(df, pd.DataFrame)
        expected_cols = {
            "plate_index",
            "label",
            "area_mm2",
            "centroid_row_mm",
            "centroid_col_mm",
            "bbox_min_row_mm",
            "bbox_min_col_mm",
            "bbox_max_row_mm",
            "bbox_max_col_mm",
            "eccentricity",
            "equivalent_diameter_mm",
            "mean_r",
            "mean_g",
            "mean_b",
        }
        assert expected_cols == set(df.columns)

    def test_row_count_matches_colonies(self) -> None:
        plate = _plate_with_colonies(colony_color=(255, 255, 255), n_colonies=8, colony_radius=30)
        result = detect_colonies(plate, dpi=_TEST_DPI)
        df = result.to_dataframe()
        assert len(df) == len(result.colonies)

    def test_empty_result_gives_empty_df(self) -> None:
        plate = _uniform_plate()
        result = detect_colonies(plate, dpi=_TEST_DPI)
        df = result.to_dataframe()
        assert len(df) == 0
        assert "plate_index" in df.columns

    def test_plate_index_propagated(self) -> None:
        plate = _plate_with_colonies(colony_color=(255, 255, 255), n_colonies=8, colony_radius=30)
        result = detect_colonies(plate, dpi=_TEST_DPI)
        df = result.to_dataframe(plate_index=3)
        assert (df["plate_index"] == 3).all()


# ------------------------------------------------------------------
# export_colony_csv
# ------------------------------------------------------------------


class TestExportColonyCsv:
    def test_writes_csv(self, tmp_path: Path) -> None:
        plate = _plate_with_colonies(colony_color=(255, 255, 255), n_colonies=8, colony_radius=30)
        result = detect_colonies(plate, dpi=_TEST_DPI)
        frames = [result.to_dataframe(plate_index=1)]
        csv_path = export_colony_csv(frames, tmp_path / "colonies.csv")
        assert csv_path.exists()
        loaded = pd.read_csv(csv_path)
        assert len(loaded) == len(result.colonies)

    def test_concatenates_multiple_plates(self, tmp_path: Path) -> None:
        df1 = pd.DataFrame({"plate_index": [1], "label": [1], "area_mm2": [0.5]})
        df2 = pd.DataFrame({"plate_index": [2], "label": [1], "area_mm2": [1.0]})
        csv_path = export_colony_csv([df1, df2], tmp_path / "multi.csv")
        loaded = pd.read_csv(csv_path)
        assert len(loaded) == 2
        assert list(loaded["plate_index"]) == [1, 2]

    def test_empty_frames_writes_empty_csv(self, tmp_path: Path) -> None:
        csv_path = export_colony_csv([], tmp_path / "empty.csv")
        assert csv_path.exists()
        loaded = pd.read_csv(csv_path)
        assert len(loaded) == 0
