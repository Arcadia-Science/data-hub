from __future__ import annotations
import logging
from pathlib import Path
from typing import Any

import imageio.v3 as iio
import numpy as np
import skimage as ski
import tifffile
from numpy.typing import NDArray

logger = logging.getLogger(__name__)

JPEG_QUALITY = 85

MAX_DIMENSION = 1000

_TIFF_SUFFIXES = {".tif", ".tiff"}

PlateBox = tuple[int, int, int, int]

_GOLD_HUE_LOW = 0.06
_GOLD_HUE_HIGH = 0.18
_GOLD_SAT_MIN = 0.25
_GOLD_VAL_MIN = 0.35

_MIN_AREA_FRACTION = 0.05
_MIN_EXTENT = 0.85

_DETECTION_DOWNSAMPLE = 4
_CLOSING_RADIUS = 5

_OVERLAY_COLOR: tuple[int, int, int] = (0, 255, 0)
_OVERLAY_THICKNESS = 6

# PhotometricInterpretation values: 2 = RGB, others (0, 1, 3) are grayscale or
# palette and are treated as B&W for our display purposes.
_PHOTOMETRIC_RGB = 2


def _derive_dpi(x_resolution: Any) -> int | None:
    """Compute integer DPI from a TIFF ``XResolution`` rational tuple."""
    if not isinstance(x_resolution, (list, tuple)) or len(x_resolution) != 2:
        return None
    numerator, denominator = x_resolution
    if not isinstance(numerator, (int, float)) or not isinstance(denominator, (int, float)):
        return None
    if denominator == 0:
        return None
    return int(numerator / denominator)


def _derive_color_mode(samples_per_pixel: Any, photometric_interpretation: Any) -> str | None:
    """Infer ``rgb`` vs ``bw`` from TIFF tags, preferring SamplesPerPixel."""
    if isinstance(samples_per_pixel, (list, tuple)):
        samples_per_pixel = samples_per_pixel[0] if samples_per_pixel else None
    if isinstance(samples_per_pixel, int):
        return "rgb" if samples_per_pixel >= 3 else "bw"
    if isinstance(photometric_interpretation, int):
        return "rgb" if photometric_interpretation == _PHOTOMETRIC_RGB else "bw"
    return None


_METADATA_TAG_NAMES = {
    "ImageWidth",
    "ImageLength",
    "BitsPerSample",
    "Compression",
    "PhotometricInterpretation",
    "SamplesPerPixel",
    "XResolution",
    "YResolution",
    "ResolutionUnit",
    "Software",
    "DateTime",
    "Artist",
    "Make",
    "Model",
    "ImageDescription",
}


class TiffProcessor:
    """Processes high-resolution TIFF scans from the Epson V700 flatbed scanner."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._intensities: NDArray[Any] | None = None
        self.plate_boxes: list[PlateBox] = []

    def load(self) -> None:
        if not self.path.exists():
            raise FileNotFoundError(f"TIFF file not found: {self.path}")
        if self.path.suffix.lower() not in _TIFF_SUFFIXES:
            raise ValueError(f"Expected TIFF file (.tif/.tiff), got: {self.path.suffix}")

        self._intensities = tifffile.imread(self.path)

    @property
    def intensities(self) -> NDArray[Any]:
        if self._intensities is None:
            raise RuntimeError("Call load() first.")
        return self._intensities

    def export_jpg(self) -> Path:
        """Detect plates, draw overlays, resize, and write a JPEG.

        If no gold frames are detected the full image is exported as-is
        (the pre-detection fallback behaviour).
        """
        img = self._to_rgb_uint8(self.intensities)
        self.plate_boxes = self.detect_plates(img)

        if self.plate_boxes:
            img = self._draw_plate_overlays(img, self.plate_boxes)

        img = self._resize(img)

        jpg_path = self.path.parent / f"{self.path.stem}.jpg"
        iio.imwrite(jpg_path, img, quality=JPEG_QUALITY)
        return jpg_path

    def parse_metadata(self) -> dict[str, Any]:
        """Extract TIFF tags as a flat string-keyed dict.

        Derived fields:

        - ``dpi``: integer DPI from ``XResolution``.
        - ``color_mode``: ``"rgb"`` or ``"bw"``.
        - ``plate_count``: number of plates detected by :meth:`export_jpg`.
        - ``plate_boxes``: list of ``[min_row, min_col, max_row, max_col]``
          bounding boxes in original-image coordinates.
        """
        metadata: dict[str, Any] = {}
        with tifffile.TiffFile(self.path) as tif:
            page = tif.pages.first
            for tag in page.tags.values():
                if tag.name in _METADATA_TAG_NAMES:
                    value = tag.value
                    if isinstance(value, tuple):
                        value = list(value)
                    metadata[tag.name] = value

        h, w = self.intensities.shape[:2]
        metadata["OriginalHeight"] = int(h)
        metadata["OriginalWidth"] = int(w)

        dpi = _derive_dpi(metadata.get("XResolution"))
        if dpi is not None:
            metadata["dpi"] = dpi

        color_mode = _derive_color_mode(
            metadata.get("SamplesPerPixel"),
            metadata.get("PhotometricInterpretation"),
        )
        if color_mode is not None:
            metadata["color_mode"] = color_mode

        metadata["plate_count"] = len(self.plate_boxes)
        metadata["plate_boxes"] = [list(b) for b in self.plate_boxes]

        return metadata

    # ------------------------------------------------------------------
    # Plate detection
    # ------------------------------------------------------------------

    @staticmethod
    def detect_plates(img: NDArray[np.uint8]) -> list[PlateBox]:
        """Detect agar plates inside gold 3D-printed frames.

        Runs detection on a downsampled copy for speed, then scales
        bounding boxes back to original coordinates.  Returns
        ``(min_row, min_col, max_row, max_col)`` sorted left-to-right.
        """
        h_orig, w_orig = img.shape[:2]
        s = _DETECTION_DOWNSAMPLE
        small: NDArray[np.uint8] = img[::s, ::s]

        hsv = ski.color.rgb2hsv(small)

        gold_mask: NDArray[np.bool_] = (
            (hsv[:, :, 0] >= _GOLD_HUE_LOW)
            & (hsv[:, :, 0] <= _GOLD_HUE_HIGH)
            & (hsv[:, :, 1] >= _GOLD_SAT_MIN)
            & (hsv[:, :, 2] >= _GOLD_VAL_MIN)
        )

        selem = ski.morphology.disk(_CLOSING_RADIUS)
        gold_mask = ski.morphology.closing(gold_mask, selem)

        inverted = ~gold_mask
        labels = ski.measure.label(inverted)
        regions = ski.measure.regionprops(labels)

        h_small, w_small = small.shape[:2]
        min_area = h_small * w_small * _MIN_AREA_FRACTION

        boxes: list[PlateBox] = []
        for region in regions:
            if region.area < min_area:
                continue
            if region.extent < _MIN_EXTENT:
                continue

            min_row, min_col, max_row, max_col = region.bbox
            touches_border = (
                min_row == 0 or min_col == 0 or max_row == h_small or max_col == w_small
            )
            if touches_border:
                continue

            boxes.append(
                (
                    min(min_row * s, h_orig),
                    min(min_col * s, w_orig),
                    min(max_row * s, h_orig),
                    min(max_col * s, w_orig),
                )
            )

        boxes.sort(key=lambda b: b[1])
        return boxes

    @staticmethod
    def _draw_plate_overlays(
        img: NDArray[np.uint8],
        boxes: list[PlateBox],
    ) -> NDArray[np.uint8]:
        """Draw coloured rectangle outlines on a copy of the image."""
        out = img.copy()
        h, w = out.shape[:2]
        for min_row, min_col, max_row, max_col in boxes:
            for offset in range(_OVERLAY_THICKNESS):
                r0 = max(min_row - offset, 0)
                c0 = max(min_col - offset, 0)
                r1 = min(max_row + offset, h - 1)
                c1 = min(max_col + offset, w - 1)
                rr, cc = ski.draw.rectangle_perimeter(
                    start=(r0, c0), end=(r1, c1), shape=out.shape[:2]
                )
                out[rr, cc] = _OVERLAY_COLOR
        return out

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _to_rgb_uint8(img: NDArray[Any]) -> NDArray[np.uint8]:
        """Normalize to 8-bit RGB regardless of input dtype/channels."""
        if img.dtype != np.uint8:
            img = ski.util.img_as_ubyte(ski.exposure.rescale_intensity(img))

        if img.ndim == 2:
            img = ski.color.gray2rgb(img)
        elif img.ndim == 3 and img.shape[2] == 4:
            img = ski.color.rgba2rgb(img)
            img = ski.util.img_as_ubyte(img)

        return img  # type: ignore[return-value]

    @staticmethod
    def _resize(img: NDArray[np.uint8]) -> NDArray[np.uint8]:
        """Downsample so the longest edge is at most MAX_DIMENSION pixels."""
        h, w = img.shape[:2]
        if max(h, w) <= MAX_DIMENSION:
            return img

        scale = MAX_DIMENSION / max(h, w)
        new_h = int(h * scale)
        new_w = int(w * scale)

        resized: NDArray[np.uint8] = np.asarray(
            ski.transform.resize(
                img,
                (new_h, new_w),
                anti_aliasing=True,
                preserve_range=True,
            ),
            dtype=np.uint8,
        )

        return resized
