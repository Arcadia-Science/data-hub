"""Colony detection and phenotyping from cropped agar-plate images.

Operates on individual plate crops produced by
:class:`~data_hub_lambda.epson_v700_scanner.image_processing.TiffProcessor`.

Pipeline
--------
1. Crop a fixed pixel margin to remove plate edges / frame artefacts.
2. Optimise contrast (Euclidean distance from estimated background colour).
3. Decide whether colonies are present (contrast above noise floor).
4. Difference-of-Gaussians band-pass filter with 10th-percentile subtraction.
5. Otsu threshold to produce a binary colony mask.
"""

from __future__ import annotations
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import skimage as ski
from numpy.typing import NDArray

logger = logging.getLogger(__name__)

MARGIN_PX = 200
"""Fixed pixel margin cropped from each edge before colony detection."""

_DOG_LOW_SIGMA = 1.0
"""Low sigma for the Difference-of-Gaussians band-pass filter."""

_DOG_HIGH_SIGMA = 128.0
"""High sigma for the Difference-of-Gaussians band-pass filter."""

_PERCENTILE_FLOOR = 10.0
"""Percentile used for baseline subtraction after DoG filtering."""

_CONTRAST_PRESENCE_THRESHOLD = 20.0
"""Minimum 99.5th-percentile contrast value to declare colonies present."""


@dataclass
class ColonyProperties:
    """Measured properties for a single colony (physical units, plate-relative)."""

    label: int
    area_mm2: float
    centroid_row_mm: float
    centroid_col_mm: float
    bbox_mm: tuple[float, float, float, float]
    eccentricity: float
    equivalent_diameter_mm: float
    mean_rgb: tuple[float, float, float]


_DATAFRAME_COLUMNS = [
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
]


@dataclass
class ColonyDetectionResult:
    """Full result of the colony-detection pipeline."""

    cropped: NDArray[Any]
    contrast: NDArray[np.floating[Any]]
    has_colonies: bool
    mask: NDArray[np.bool_]
    colonies: list[ColonyProperties] = field(default_factory=list)

    def summary(self) -> dict[str, Any]:
        """Return a JSON-serialisable summary dict."""
        return {
            "has_colonies": self.has_colonies,
            "colony_count": len(self.colonies),
            "colonies": [
                {
                    "label": c.label,
                    "area_mm2": round(c.area_mm2, 4),
                    "centroid_mm": [
                        round(c.centroid_row_mm, 3),
                        round(c.centroid_col_mm, 3),
                    ],
                    "bbox_mm": [round(v, 3) for v in c.bbox_mm],
                    "eccentricity": round(c.eccentricity, 4),
                    "equivalent_diameter_mm": round(c.equivalent_diameter_mm, 4),
                    "mean_rgb": [round(v, 1) for v in c.mean_rgb],
                }
                for c in self.colonies
            ],
        }

    def to_dataframe(self, plate_index: int = 0) -> pd.DataFrame:
        """Return a :class:`~pandas.DataFrame` with one row per colony."""
        if not self.colonies:
            return pd.DataFrame(columns=_DATAFRAME_COLUMNS)
        rows = []
        for c in self.colonies:
            rows.append(
                {
                    "plate_index": plate_index,
                    "label": c.label,
                    "area_mm2": round(c.area_mm2, 4),
                    "centroid_row_mm": round(c.centroid_row_mm, 3),
                    "centroid_col_mm": round(c.centroid_col_mm, 3),
                    "bbox_min_row_mm": round(c.bbox_mm[0], 3),
                    "bbox_min_col_mm": round(c.bbox_mm[1], 3),
                    "bbox_max_row_mm": round(c.bbox_mm[2], 3),
                    "bbox_max_col_mm": round(c.bbox_mm[3], 3),
                    "eccentricity": round(c.eccentricity, 4),
                    "equivalent_diameter_mm": round(c.equivalent_diameter_mm, 4),
                    "mean_r": round(c.mean_rgb[0], 1),
                    "mean_g": round(c.mean_rgb[1], 1),
                    "mean_b": round(c.mean_rgb[2], 1),
                }
            )
        return pd.DataFrame(rows)


# ------------------------------------------------------------------
# Pipeline steps
# ------------------------------------------------------------------


def crop_margin(image: NDArray[Any], margin_px: int = MARGIN_PX) -> NDArray[Any]:
    """Remove a fixed pixel margin from each edge of *image*.

    Args:
        image: (H, W) or (H, W, C) array.
        margin_px: Number of pixels to remove from each side.

    Returns:
        Cropped view of the original array.
    """
    h, w = image.shape[:2]
    return image[margin_px : h - margin_px, margin_px : w - margin_px]


def optimize_colony_contrast(image: NDArray[Any]) -> NDArray[np.floating[Any]]:
    """Convert to a single channel that maximises colony-background contrast.

    Per-pixel Euclidean distance from the estimated background colour
    (median of non-zero pixels).  Colonies of any colour appear bright
    against a near-zero background.

    Args:
        image: (H, W) or (H, W, C) array.

    Returns:
        (H, W) float64 distance-from-background image.
    """
    if image.ndim == 2:
        return image.astype(np.float64)

    pixels = image.reshape(-1, image.shape[-1])
    nonzero = np.any(pixels > 0, axis=1)
    background: NDArray[np.floating[Any]]
    if nonzero.any():
        background = np.median(pixels[nonzero], axis=0)
    else:
        background = np.median(pixels, axis=0)

    diff = image.astype(np.float64) - background
    distance: NDArray[np.floating[Any]] = np.sqrt(np.sum(diff**2, axis=-1))
    distance[~np.any(image > 0, axis=-1)] = 0.0
    return distance


def detect_colony_presence(
    contrast: NDArray[np.floating[Any]],
    threshold: float = _CONTRAST_PRESENCE_THRESHOLD,
) -> bool:
    """Return ``True`` if there is enough contrast to indicate colonies.

    Uses the 99.5th percentile of the contrast image; plates without
    colonies have near-uniform background.
    """
    if contrast.size == 0:
        return False
    p = float(np.percentile(contrast, 99.5))
    logger.debug("Colony-presence p99.5 contrast = %.2f (threshold %.2f)", p, threshold)
    return p > threshold


def smooth(
    contrast: NDArray[np.floating[Any]],
    low_sigma: float = _DOG_LOW_SIGMA,
    high_sigma: float = _DOG_HIGH_SIGMA,
    percentile: float = _PERCENTILE_FLOOR,
) -> NDArray[np.floating[Any]]:
    """Apply Difference-of-Gaussians band-pass filter with percentile subtraction.

    The DoG filter retains structures between *low_sigma* and *high_sigma*
    scale, suppressing both high-frequency noise and low-frequency background
    gradients.  A 10th-percentile baseline is then subtracted and negative
    values are clipped to zero so the result stays non-negative for Otsu
    thresholding.
    """
    dog: NDArray[np.floating[Any]] = ski.filters.difference_of_gaussians(
        contrast,
        low_sigma=low_sigma,
        high_sigma=high_sigma,
    )
    floor = np.percentile(dog, percentile)
    result: NDArray[np.floating[Any]] = np.clip(dog - floor, 0, None)
    return result


def threshold_colonies(smoothed: NDArray[np.floating[Any]]) -> NDArray[np.bool_]:
    """Otsu threshold to produce a binary colony mask."""
    thresh = ski.filters.threshold_otsu(smoothed)
    mask: NDArray[np.bool_] = smoothed > thresh
    return mask


def measure_colonies(
    mask: NDArray[np.bool_],
    rgb_image: NDArray[np.uint8],
    dpi: int,
    margin_px: int = MARGIN_PX,
) -> list[ColonyProperties]:
    """Label connected components and extract per-colony measurements.

    All spatial measurements are returned in millimetres.  Centroids and
    bounding boxes are expressed relative to the plate crop origin (i.e.
    the margin offset is added back before conversion).

    Args:
        mask: Binary colony mask (margin-cropped coordinate space).
        rgb_image: RGB uint8 image with the same shape as *mask*
            (margin-cropped).  Used as ``intensity_image`` so that
            ``regionprops`` can compute per-colony mean colour.
        dpi: Image resolution in dots-per-inch.
        margin_px: Pixel margin that was removed from the plate crop.
    """
    mm_per_px = 25.4 / dpi

    labels = ski.measure.label(mask)
    labels = ski.segmentation.clear_border(labels)
    regions = ski.measure.regionprops(labels, intensity_image=rgb_image)

    colonies: list[ColonyProperties] = []
    for region in regions:
        row_px = float(region.centroid[0]) + margin_px
        col_px = float(region.centroid[1]) + margin_px

        min_r, min_c, max_r, max_c = region.bbox
        bbox_mm = (
            (min_r + margin_px) * mm_per_px,
            (min_c + margin_px) * mm_per_px,
            (max_r + margin_px) * mm_per_px,
            (max_c + margin_px) * mm_per_px,
        )

        rgb_mean = region.intensity_mean
        mean_rgb = (float(rgb_mean[0]), float(rgb_mean[1]), float(rgb_mean[2]))

        colonies.append(
            ColonyProperties(
                label=int(region.label),
                area_mm2=float(region.area) * mm_per_px**2,
                centroid_row_mm=row_px * mm_per_px,
                centroid_col_mm=col_px * mm_per_px,
                bbox_mm=bbox_mm,
                eccentricity=float(region.eccentricity),
                equivalent_diameter_mm=float(region.equivalent_diameter_area) * mm_per_px,
                mean_rgb=mean_rgb,
            )
        )

    colonies.sort(key=lambda c: c.area_mm2, reverse=True)
    return colonies


# ------------------------------------------------------------------
# Visualisation & export
# ------------------------------------------------------------------


def export_colony_csv(
    frames: list[pd.DataFrame],
    path: Path,
) -> Path:
    """Concatenate per-plate DataFrames and write a CSV."""
    if frames:
        combined = pd.concat(frames, ignore_index=True)
    else:
        combined = pd.DataFrame(columns=_DATAFRAME_COLUMNS)
    combined.to_csv(path, index=False)
    logger.debug("Wrote colony CSV: %s", path)
    return path


# ------------------------------------------------------------------
# Orchestrator
# ------------------------------------------------------------------


def detect_colonies(plate_image: NDArray[Any], dpi: int) -> ColonyDetectionResult:
    """Run the full colony-detection pipeline on a single plate crop.

    Args:
        plate_image: RGB uint8 plate image produced by
            :class:`~data_hub_lambda.epson_v700_scanner.image_processing.TiffProcessor`.
        dpi: Image resolution in dots-per-inch, used to convert pixel
            measurements to millimetres.

    Returns:
        A :class:`ColonyDetectionResult` with all intermediate arrays
        and measured colony properties.
    """
    cropped = crop_margin(plate_image)
    contrast = optimize_colony_contrast(cropped)
    has_colonies = detect_colony_presence(contrast)

    if not has_colonies:
        logger.info("No colonies detected (low contrast).")
        return ColonyDetectionResult(
            cropped=cropped,
            contrast=contrast,
            has_colonies=False,
            mask=np.zeros(contrast.shape, dtype=bool),
        )

    smoothed = smooth(contrast)
    mask = threshold_colonies(smoothed)
    colonies = measure_colonies(mask, rgb_image=cropped, dpi=dpi)

    logger.info("Detected %d colony/ies.", len(colonies))
    return ColonyDetectionResult(
        cropped=cropped,
        contrast=contrast,
        has_colonies=True,
        mask=mask,
        colonies=colonies,
    )
