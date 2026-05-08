from __future__ import annotations
import logging
from pathlib import Path
from typing import Any

import numpy as np
import skimage as ski
import tifffile
from numpy.typing import NDArray

logger = logging.getLogger(__name__)

JPEG_QUALITY = 85

MAX_DIMENSION = 1000

_TIFF_SUFFIXES = {".tif", ".tiff"}

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


class TIFFToJPEGConverter:
    """Converts high-resolution TIFF scans to resized JPEG images."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._intensities: NDArray[Any] | None = None

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
        """Resize the loaded TIFF and write a JPEG next to the source file."""
        img = self._to_rgb_uint8(self.intensities)
        img = self._resize(img)

        jpg_path = self.path.parent / f"{self.path.stem}.jpg"
        ski.io.imsave(str(jpg_path), img, quality=JPEG_QUALITY)
        return jpg_path

    def parse_metadata(self) -> dict[str, Any]:
        """Extract TIFF tags as a flat string-keyed dict.

        In addition to the raw TIFF tags, this also emits two derived
        scalar fields used by the web UI for filtering and display:

        - ``dpi``: integer DPI computed from ``XResolution`` (a (numerator,
          denominator) rational). For Epson V700 scans this is 300 or 600.
        - ``color_mode``: ``"rgb"`` or ``"bw"``, inferred from
          ``SamplesPerPixel`` (preferred) or ``PhotometricInterpretation``.
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

        return metadata

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
