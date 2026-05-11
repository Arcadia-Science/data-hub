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
"""Minimum 95th-percentile contrast value to declare colonies present."""


@dataclass
class ColonyProperties:
    """Measured properties for a single colony."""

    label: int
    area_px: int
    centroid_row: float
    centroid_col: float
    bbox: tuple[int, int, int, int]
    eccentricity: float
    equivalent_diameter: float


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
                    "area_px": c.area_px,
                    "centroid": [round(c.centroid_row, 1), round(c.centroid_col, 1)],
                    "bbox": list(c.bbox),
                    "eccentricity": round(c.eccentricity, 4),
                    "equivalent_diameter": round(c.equivalent_diameter, 2),
                }
                for c in self.colonies
            ],
        }

    def to_dataframe(self, plate_index: int = 0) -> pd.DataFrame:
        """Return a :class:`~pandas.DataFrame` with one row per colony."""
        if not self.colonies:
            return pd.DataFrame(
                columns=[
                    "plate_index",
                    "label",
                    "area_px",
                    "centroid_row",
                    "centroid_col",
                    "bbox_min_row",
                    "bbox_min_col",
                    "bbox_max_row",
                    "bbox_max_col",
                    "eccentricity",
                    "equivalent_diameter",
                ]
            )
        rows = []
        for c in self.colonies:
            rows.append(
                {
                    "plate_index": plate_index,
                    "label": c.label,
                    "area_px": c.area_px,
                    "centroid_row": round(c.centroid_row, 1),
                    "centroid_col": round(c.centroid_col, 1),
                    "bbox_min_row": c.bbox[0],
                    "bbox_min_col": c.bbox[1],
                    "bbox_max_row": c.bbox[2],
                    "bbox_max_col": c.bbox[3],
                    "eccentricity": round(c.eccentricity, 4),
                    "equivalent_diameter": round(c.equivalent_diameter, 2),
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


def measure_colonies(mask: NDArray[np.bool_]) -> list[ColonyProperties]:
    """Label connected components and extract per-colony measurements."""
    labels = ski.measure.label(mask)
    regions = ski.measure.regionprops(labels)

    colonies: list[ColonyProperties] = []
    for region in regions:
        colonies.append(
            ColonyProperties(
                label=int(region.label),
                area_px=int(region.area),
                centroid_row=float(region.centroid[0]),
                centroid_col=float(region.centroid[1]),
                bbox=tuple(region.bbox),  # type: ignore[arg-type]
                eccentricity=float(region.eccentricity),
                equivalent_diameter=float(region.equivalent_diameter_area),
            )
        )

    colonies.sort(key=lambda c: c.area_px, reverse=True)
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
        combined = pd.DataFrame(
            columns=[
                "plate_index",
                "label",
                "area_px",
                "centroid_row",
                "centroid_col",
                "bbox_min_row",
                "bbox_min_col",
                "bbox_max_row",
                "bbox_max_col",
                "eccentricity",
                "equivalent_diameter",
            ]
        )
    combined.to_csv(path, index=False)
    logger.debug("Wrote colony CSV: %s", path)
    return path


# ------------------------------------------------------------------
# Orchestrator
# ------------------------------------------------------------------


def detect_colonies(plate_image: NDArray[Any]) -> ColonyDetectionResult:
    """Run the full colony-detection pipeline on a single plate crop.

    Args:
        plate_image: RGB uint8 plate image produced by
            :class:`~data_hub_lambda.epson_v700_scanner.image_processing.TiffProcessor`.

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
    colonies = measure_colonies(mask)

    logger.info("Detected %d colony/ies.", len(colonies))
    return ColonyDetectionResult(
        cropped=cropped,
        contrast=contrast,
        has_colonies=True,
        mask=mask,
        colonies=colonies,
    )
