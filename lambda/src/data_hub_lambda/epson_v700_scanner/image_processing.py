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

MAX_DIMENSION = 2000

_TIFF_SUFFIXES = {".tif", ".tiff"}

_PlateBox = tuple[int, int, int, int]

_GOLD_HUE_LOW = 0.06
_GOLD_HUE_HIGH = 0.18
_GOLD_SAT_MIN = 0.25
_GOLD_VAL_MIN = 0.35

_MIN_AREA_FRACTION = 0.05
_MIN_EXTENT = 0.85

_DETECTION_DOWNSAMPLE = 4
_CLOSING_RADIUS = 5

_OVERLAY_COLOR: tuple[int, int, int] = (0, 255, 0)
_OVERLAY_THICKNESS = 8

_COLONY_CONTOUR_COLOR: tuple[int, int, int] = (255, 0, 255)
_COLONY_CONTOUR_THICKNESS = 2

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
    return round(numerator / denominator)


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
        self.plate_boxes: list[_PlateBox] | None = None

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

    def export_jpg(
        self,
        colony_masks: list[NDArray[np.bool_]] | None = None,
    ) -> Path:
        """Detect plates, draw overlays, resize, and write a JPEG.

        If no gold frames are detected the full image is exported as-is
        (the pre-detection fallback behaviour).

        Args:
            colony_masks: Optional per-plate binary masks (one per entry in
                ``plate_boxes``).  When provided, colony contour outlines
                are drawn on the export image.
        """
        img = self._to_rgb_uint8(self.intensities)
        if self.plate_boxes is None:
            self.detect_plates(img)

        if self.plate_boxes:
            img = self._draw_plate_overlays(img, self.plate_boxes)
            if colony_masks:
                img = self._draw_colony_contours(img, self.plate_boxes, colony_masks)

        img = self._resize(img)

        jpg_path = self.path.parent / f"{self.path.stem}.jpg"
        iio.imwrite(jpg_path, img, quality=JPEG_QUALITY)
        return jpg_path

    def parse_metadata(self) -> dict[str, Any]:
        """Extract TIFF tags as a flat string-keyed dict.

        Derived fields:

        - ``dpi``: integer DPI from ``XResolution``.
        - ``color_mode``: ``"rgb"`` or ``"bw"``.
        - ``plate_count``: number of detected plates (only present after
          :meth:`export_jpg` has been called).
        - ``plate_boxes``: list of ``[min_row, min_col, max_row, max_col]``
          bounding boxes in original-image coordinates (only present after
          :meth:`export_jpg` has been called).
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

        if self.plate_boxes is not None:
            metadata["plate_count"] = len(self.plate_boxes)
            metadata["plate_boxes"] = [list(b) for b in self.plate_boxes]
        else:
            logger.warning(
                "plate_boxes is None; call export_jpg() before"
                " parse_metadata() to include plate data"
            )

        return metadata

    # ------------------------------------------------------------------
    # Plate detection
    # ------------------------------------------------------------------

    def detect_plates(self, img: NDArray[np.uint8] | None = None) -> None:
        """Detect agar plates inside gold 3D-printed frames.

        Runs detection on a downsampled copy for speed, then scales
        bounding boxes back to original coordinates.  Results are stored
        in ``self.plate_boxes`` as ``(min_row, min_col, max_row, max_col)``
        tuples sorted left-to-right.

        Args:
            img: Optional RGB uint8 image.  When *None* the image is
                derived from ``self.intensities``.
        """
        if img is None:
            img = self._to_rgb_uint8(self.intensities)
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

        boxes: list[_PlateBox] = []
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
        self.plate_boxes = boxes
        logger.debug("Detected %d plate(s): %s", len(boxes), boxes)

    @staticmethod
    def _draw_plate_overlays(
        img: NDArray[np.uint8],
        boxes: list[_PlateBox],
    ) -> NDArray[np.uint8]:
        """Draw coloured rectangle outlines on a copy of the image.

        Assumes non-overlapping boxes; overlapping boxes would cause
        later interior restores to overwrite earlier overlay lines.
        """
        out = img.copy()
        h, w = out.shape[:2]
        t = _OVERLAY_THICKNESS
        for min_row, min_col, max_row, max_col in boxes:
            r0 = max(min_row - t, 0)
            c0 = max(min_col - t, 0)
            r1 = min(max_row + t, h)
            c1 = min(max_col + t, w)
            out[r0:r1, c0:c1] = _OVERLAY_COLOR
            out[min_row:max_row, min_col:max_col] = img[min_row:max_row, min_col:max_col]
        return out

    @staticmethod
    def _draw_colony_contours(
        img: NDArray[np.uint8],
        boxes: list[_PlateBox],
        colony_masks: list[NDArray[np.bool_]],
        margin_px: int | None = None,
    ) -> NDArray[np.uint8]:
        """Draw colony contour outlines onto *img* for each plate.

        Each mask lives in the margin-cropped coordinate space of its
        plate crop, so contours are offset by the plate box origin plus
        the crop margin.
        """
        if margin_px is None:
            from data_hub_lambda.epson_v700_scanner.colony_detection import MARGIN_PX

            margin_px = MARGIN_PX

        out = img.copy()
        h, w = out.shape[:2]
        t = _COLONY_CONTOUR_THICKNESS
        for box, mask in zip(boxes, colony_masks, strict=True):
            min_row, min_col, _max_row, _max_col = box
            row_offset = min_row + margin_px
            col_offset = min_col + margin_px

            contours = ski.measure.find_contours(mask.astype(float), level=0.5)
            for contour in contours:
                for r_f, c_f in contour:
                    r = int(round(r_f)) + row_offset
                    c = int(round(c_f)) + col_offset
                    r0, r1 = max(r - t, 0), min(r + t + 1, h)
                    c0, c1 = max(c - t, 0), min(c + t + 1, w)
                    out[r0:r1, c0:c1] = _COLONY_CONTOUR_COLOR
        return out

    def crop_plates(self) -> list[NDArray[np.uint8]]:
        """Return RGB uint8 crops for each detected plate.

        Must be called after :meth:`export_jpg` (or :meth:`detect_plates`)
        so that ``plate_boxes`` is populated.
        """
        if self.plate_boxes is None:
            raise RuntimeError("Call export_jpg() or detect_plates() first.")
        img = self._to_rgb_uint8(self.intensities)
        crops: list[NDArray[np.uint8]] = []
        for min_row, min_col, max_row, max_col in self.plate_boxes:
            crops.append(img[min_row:max_row, min_col:max_col].copy())
        return crops

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _to_rgb_uint8(img: NDArray[Any]) -> NDArray[np.uint8]:
        """Normalize to 8-bit RGB regardless of input dtype/channels."""
        if img.ndim == 3 and img.shape[2] == 4:
            img = ski.color.rgba2rgb(img)

        if img.dtype != np.uint8:
            img = ski.util.img_as_ubyte(ski.exposure.rescale_intensity(img))

        if img.ndim == 2:
            img = ski.color.gray2rgb(img)

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
