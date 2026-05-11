"""Unit tests for `epson_v700_scanner.colony_detection`."""

from __future__ import annotations

import numpy as np

from data_hub_lambda.epson_v700_scanner.colony_detection import (
    MARGIN_FRACTION,
    ColonyDetectionResult,
    ColonyProperties,
    crop_margin,
    detect_colonies,
    detect_colony_presence,
    measure_colonies,
    optimize_colony_contrast,
    smooth,
    threshold_colonies,
)


def _uniform_plate(h: int = 400, w: int = 400, value: int = 120) -> np.ndarray:  # type: ignore[type-arg]
    """Create a uniform-colour plate image (no colonies)."""
    return np.full((h, w, 3), value, dtype=np.uint8)


def _plate_with_colonies(
    h: int = 400,
    w: int = 400,
    bg: int = 120,
    colony_color: tuple[int, int, int] = (255, 255, 255),
    n_colonies: int = 3,
    colony_radius: int = 15,
) -> np.ndarray:  # type: ignore[type-arg]
    """Create a synthetic plate with circular colonies inside the margin."""
    img = np.full((h, w, 3), bg, dtype=np.uint8)
    rng = np.random.RandomState(42)
    margin = int(max(h, w) * MARGIN_FRACTION) + colony_radius + 5
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
    def test_default_removes_10pct(self) -> None:
        img = np.zeros((200, 300, 3), dtype=np.uint8)
        cropped = crop_margin(img)
        expected_h = 200 - 2 * int(200 * MARGIN_FRACTION)
        expected_w = 300 - 2 * int(300 * MARGIN_FRACTION)
        assert cropped.shape == (expected_h, expected_w, 3)

    def test_grayscale(self) -> None:
        img = np.zeros((100, 100), dtype=np.uint8)
        cropped = crop_margin(img)
        margin = int(100 * MARGIN_FRACTION)
        assert cropped.shape == (100 - 2 * margin, 100 - 2 * margin)

    def test_custom_margin(self) -> None:
        img = np.zeros((200, 200, 3), dtype=np.uint8)
        cropped = crop_margin(img, margin=0.25)
        assert cropped.shape == (100, 100, 3)

    def test_preserves_content(self) -> None:
        img = np.arange(100 * 100, dtype=np.uint8).reshape(100, 100)
        cropped = crop_margin(img, margin=0.10)
        m = int(100 * 0.10)
        np.testing.assert_array_equal(cropped, img[m : 100 - m, m : 100 - m])


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
        result = smooth(img, sigma=3.0)
        assert result.std() < img.std()


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


class TestMeasureColonies:
    def test_empty_mask_returns_empty(self) -> None:
        mask = np.zeros((100, 100), dtype=bool)
        assert measure_colonies(mask) == []

    def test_single_blob(self) -> None:
        mask = np.zeros((100, 100), dtype=bool)
        mask[40:60, 40:60] = True
        colonies = measure_colonies(mask)
        assert len(colonies) == 1
        assert colonies[0].area_px == 20 * 20

    def test_two_blobs_sorted_by_area(self) -> None:
        mask = np.zeros((200, 200), dtype=bool)
        mask[10:20, 10:20] = True  # 100 px
        mask[50:80, 50:80] = True  # 900 px
        colonies = measure_colonies(mask)
        assert len(colonies) == 2
        assert colonies[0].area_px > colonies[1].area_px

    def test_colony_properties_populated(self) -> None:
        mask = np.zeros((100, 100), dtype=bool)
        mask[40:60, 40:60] = True
        colony = measure_colonies(mask)[0]
        assert isinstance(colony, ColonyProperties)
        assert colony.label >= 1
        assert colony.eccentricity >= 0.0
        assert colony.equivalent_diameter > 0.0
        assert len(colony.bbox) == 4


# ------------------------------------------------------------------
# detect_colonies (full pipeline)
# ------------------------------------------------------------------


class TestDetectColonies:
    def test_uniform_plate_no_colonies(self) -> None:
        plate = _uniform_plate()
        result = detect_colonies(plate)
        assert isinstance(result, ColonyDetectionResult)
        assert result.has_colonies is False
        assert result.colonies == []
        assert result.mask.shape == result.contrast.shape
        assert not result.mask.any()

    def test_plate_with_colonies_detected(self) -> None:
        plate = _plate_with_colonies(
            h=600, w=600, colony_color=(255, 255, 255), n_colonies=8, colony_radius=30
        )
        result = detect_colonies(plate)
        assert result.has_colonies is True
        assert len(result.colonies) > 0

    def test_summary_schema(self) -> None:
        plate = _plate_with_colonies(n_colonies=2)
        result = detect_colonies(plate)
        summary = result.summary()
        assert "has_colonies" in summary
        assert "colony_count" in summary
        assert isinstance(summary["colonies"], list)
        if summary["colonies"]:
            c = summary["colonies"][0]
            assert "label" in c
            assert "area_px" in c
            assert "centroid" in c
            assert "bbox" in c
            assert "eccentricity" in c
            assert "equivalent_diameter" in c

    def test_cropped_smaller_than_input(self) -> None:
        plate = _uniform_plate(400, 400)
        result = detect_colonies(plate)
        assert result.cropped.shape[0] < 400
        assert result.cropped.shape[1] < 400

    def test_grayscale_input(self) -> None:
        plate = np.full((200, 200), 128, dtype=np.uint8)
        result = detect_colonies(plate)
        assert isinstance(result, ColonyDetectionResult)
