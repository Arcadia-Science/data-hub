from __future__ import annotations
import logging
from pathlib import Path

import numpy as np
import skimage as ski
from arcadia_microscopy_tools import MicroscopyImage
from arcadia_microscopy_tools.blending import overlay_channels
from arcadia_microscopy_tools.channels import BRIGHTFIELD, Channel
from numpy.typing import NDArray
from PIL import Image

logger = logging.getLogger(__name__)

ND2_SUFFIXES = (".nd2",)

# Percentile range for per-channel contrast stretching before overlay.
# 1st-99th percentile clips hot pixels / rare noise peaks while keeping the
# bulk of the dynamic range visible.
CONTRAST_PERCENTILES: tuple[float, float] = (1.0, 99.0)

# JPEG quality for the exported composite.
JPEG_QUALITY = 90


class ND2Processor:
    """Convert a Nikon ND2 file into a per-run JPG preview.

    The pipeline uses `arcadia_microscopy_tools.MicroscopyImage` to load the
    ND2, reduces each channel down to a single 2D frame (max-projection over
    Z, first index over T / P), percentile-stretches intensities, and then
    composites the channels into an RGB overlay using each channel's native
    fluorophore color via `overlay_channels`.
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        self._image: MicroscopyImage | None = None

    def load(self) -> None:
        if not self.path.exists():
            raise FileNotFoundError(f"ND2 file not found: {self.path}")
        if self.path.suffix.lower() not in ND2_SUFFIXES:
            raise ValueError(f"Expected ND2 file (.nd2), got: {self.path.suffix}")

        self._image = MicroscopyImage.from_nd2_path(self.path)

    @property
    def image(self) -> MicroscopyImage:
        if self._image is None:
            raise RuntimeError("Call load() first.")
        return self._image

    def export_jpg(self) -> Path:
        """Render the composite overlay and write it as a JPG next to the source."""
        rgb = self._render_rgb()
        rgb_uint8 = (np.clip(rgb, 0.0, 1.0) * 255).astype(np.uint8)

        jpg_path = self.path.parent / f"{self.path.stem}.jpg"
        Image.fromarray(rgb_uint8, mode="RGB").save(jpg_path, format="JPEG", quality=JPEG_QUALITY)
        return jpg_path

    def _render_rgb(self) -> NDArray[np.float64]:
        """Produce the RGB overlay for the loaded image."""
        per_channel_2d: dict[Channel, NDArray[np.float64]] = {}
        for channel in self.image.channels:
            intensities = self.image.get_channel_intensities(channel)
            reduced = self._reduce_to_2d(intensities, self._non_channel_axes())
            per_channel_2d[channel] = _rescale_percentile(reduced, CONTRAST_PERCENTILES)

        background = self._pick_background(per_channel_2d)

        # Fluorescence channels are overlaid on top of the grayscale background.
        # Skip the background channel (if it was picked from the image) so it
        # isn't blended onto itself.
        overlay_inputs = {
            ch: arr for ch, arr in per_channel_2d.items() if ch.name != BRIGHTFIELD.name
        }
        if not overlay_inputs:
            # Single-channel brightfield (or equivalent): return the background
            # as an RGB image so the caller still gets a valid overlay.
            return ski.color.gray2rgb(background)

        return overlay_channels(background, overlay_inputs)

    def _non_channel_axes(self) -> list[str]:
        """Ordered axis labels for the per-channel array (C dropped)."""
        return [axis for axis in self.image.sizes.keys() if axis != "C"]

    @staticmethod
    def _reduce_to_2d(
        intensities: NDArray,  # type: ignore[type-arg]
        axis_labels: list[str],
    ) -> NDArray[np.float64]:
        """Collapse leading axes down to a (Y, X) frame.

        Z axes are max-projected; T and P axes fall back to the first index.
        Any unknown leading axis is also reduced by taking the first index,
        with a warning logged.
        """
        arr = intensities
        labels = list(axis_labels)
        while len(labels) > 2:
            label = labels[0]
            if label == "Z":
                arr = arr.max(axis=0)
            elif label in ("T", "P"):
                logger.info(
                    "Reducing axis %s (size %d) by taking first index only.",
                    label,
                    arr.shape[0],
                )
                arr = arr[0]
            else:
                logger.warning(
                    "Unknown leading axis %s (size %d); taking first index.",
                    label,
                    arr.shape[0],
                )
                arr = arr[0]
            labels = labels[1:]
        return arr

    @staticmethod
    def _pick_background(
        per_channel: dict[Channel, NDArray[np.float64]],
    ) -> NDArray[np.float64]:
        """Pick a grayscale [0, 1] background for the overlay.

        Prefers an existing BRIGHTFIELD channel (gives a natural context
        image); falls back to zeros with the same 2D shape as the first
        channel so fluorescence alone still renders correctly.
        """
        for channel, arr in per_channel.items():
            if channel.name == BRIGHTFIELD.name:
                return arr

        first = next(iter(per_channel.values()))
        return np.zeros_like(first, dtype=np.float64)


def _rescale_percentile(
    intensities: NDArray,  # type: ignore[type-arg]
    percentiles: tuple[float, float],
) -> NDArray[np.float64]:
    """Percentile-based contrast stretching into [0, 1]."""
    if intensities.size == 0:
        return np.zeros_like(intensities, dtype=np.float64)

    lo, hi = np.percentile(intensities, percentiles)
    if lo == hi:
        return np.zeros_like(intensities, dtype=np.float64)

    rescaled = ski.exposure.rescale_intensity(
        intensities,
        in_range=(lo, hi),  # type: ignore[arg-type]
        out_range=(0.0, 1.0),  # type: ignore[arg-type]
    )
    return rescaled.astype(np.float64)
