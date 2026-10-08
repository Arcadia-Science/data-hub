from __future__ import annotations
import logging
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import nd2
import numpy as np
import skimage as ski
from arcadia_microscopy_tools.blending import overlay_channels
from arcadia_microscopy_tools.channels import BRIGHTFIELD, Channel
from arcadia_microscopy_tools.metadata_structures import DimensionFlags
from arcadia_microscopy_tools.nikon import _NikonMetadataParser
from numpy.typing import NDArray
from PIL import Image

from data_hub_lambda.deadline import check_deadline

logger = logging.getLogger(__name__)

ND2_SUFFIXES = (".nd2",)

# Percentile range for per-channel contrast stretching before overlay.
# 1st-99th percentile clips hot pixels / rare noise peaks while keeping the
# bulk of the dynamic range visible.
CONTRAST_PERCENTILES: tuple[float, float] = (1.0, 99.0)

# JPEG quality for the exported composite.
JPEG_QUALITY = 90

# Measured render peak: `_PREVIEW_BYTES_PER_PIXEL` per image pixel plus
# `_PREVIEW_BYTES_PER_CHANNEL_PIXEL` per pixel per channel. At the cap, the
# process peaked near 6.2 GB of the 10,240 MB Lambda.
_PREVIEW_BYTES_PER_PIXEL = 128
_PREVIEW_BYTES_PER_CHANNEL_PIXEL = 10
MAX_PREVIEW_BYTES = 4 * 1024**3

# Reading holds the running projection and one decoded frame, because
# `_reduce_loops` frees each frame before it decodes the next. The same cap
# bounds them, so an image whose planes do not fit still fails.
_PLANE_COPIES_WHILE_READING = 2

PREVIEW_TOO_LARGE_MESSAGE = (
    "Image is too large for a preview. The raw file is stored and can be downloaded."
)

RGB_NOT_SUPPORTED_MESSAGE = (
    "RGB ND2 files from color cameras are not supported for previews. "
    "The raw file is stored and can be downloaded."
)


@dataclass(frozen=True)
class ND2Summary:
    """The ND2 metadata `parse_metadata` reads, without the decoded pixels."""

    sizes: dict[str, int]
    channels: list[Channel]
    dimensions: DimensionFlags


class ND2Processor:
    """Convert a Nikon ND2 file into a per-run JPG preview.

    The pipeline reads the ND2 one frame at a time, reduces each channel to
    a single 2D frame (max-projection over Z, first index over T / P),
    averages blocks of pixels when the render would not fit in memory,
    percentile-stretches intensities, and then composites the channels into
    an RGB overlay using each channel's native fluorophore color via
    `overlay_channels`.
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        self._image: ND2Summary | None = None
        self._planes: list[NDArray[Any]] | None = None

    def load(self) -> None:
        if not self.path.exists():
            raise FileNotFoundError(f"ND2 file not found: {self.path}")
        if self.path.suffix.lower() not in ND2_SUFFIXES:
            raise ValueError(f"Expected ND2 file (.nd2), got: {self.path.suffix}")

        # `from_nd2_path` decodes every pixel at once, so read the metadata and
        # the preview frames from one handle. Move to `parse_nd2` deliberately
        # with the 0.5.0 lock bump; it is a different parser.
        with nd2.ND2File(self.path) as nd2f:
            metadata = _NikonMetadataParser(self.path).parse(nd2f)
            if read_peak_bytes(metadata.sizes, nd2f.dtype.itemsize) > MAX_PREVIEW_BYTES:
                raise ValueError(PREVIEW_TOO_LARGE_MESSAGE)
            planes = _preview_planes(nd2f, metadata.sizes)

        factor = preview_shrink_factor(metadata.sizes)
        if factor > 1:
            logger.info("Shrinking the preview of %s by %dx.", self.path.name, factor)
        self._planes = _shrink_planes(planes, factor)
        self._image = ND2Summary(
            sizes=metadata.sizes,
            channels=[item.channel for item in metadata.channel_metadata_list],
            dimensions=metadata.dimensions,
        )

    @property
    def image(self) -> ND2Summary:
        if self._image is None:
            raise RuntimeError("Call load() first.")
        return self._image

    def export_jpg(self, *, output_dir: Path | None = None) -> Path:
        """Render the composite overlay and write it as a JPG.

        *output_dir* is required when the ND2 was opened from the read-only
        mount. The default writes next to the source for local files.
        """
        rgb = self._render_rgb()
        rgb_uint8 = (np.clip(rgb, 0.0, 1.0) * 255).astype(np.uint8)

        dest_dir = self.path.parent if output_dir is None else output_dir
        dest_dir.mkdir(parents=True, exist_ok=True)
        jpg_path = dest_dir / f"{self.path.stem}.jpg"
        Image.fromarray(rgb_uint8, mode="RGB").save(jpg_path, format="JPEG", quality=JPEG_QUALITY)
        return jpg_path

    def _render_rgb(self) -> NDArray[np.float64]:
        """Produce the RGB overlay for the loaded image."""
        if self._planes is None:
            raise RuntimeError("Call load() first.")
        per_channel_2d: dict[Channel, NDArray[np.float64]] = {}
        for channel, plane in zip(self.image.channels, self._planes, strict=True):
            per_channel_2d[channel] = _rescale_percentile(plane, CONTRAST_PERCENTILES)

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


def preview_bytes(sizes: Mapping[str, int]) -> int:
    """Estimated peak memory to render a preview of an image with *sizes*."""
    return _render_bytes(*_image_shape(sizes))


def read_peak_bytes(sizes: Mapping[str, int], itemsize: int) -> int:
    """Estimated peak memory to read the full-size planes of an image with *sizes*."""
    height, width, channels = _image_shape(sizes)
    return _PLANE_COPIES_WHILE_READING * height * width * channels * itemsize


def preview_shrink_factor(sizes: Mapping[str, int]) -> int:
    """Smallest whole-number factor that brings the render within `MAX_PREVIEW_BYTES`.

    Returns 1 for an image that already fits, so its preview is unchanged. The
    factor never exceeds the shorter side, which keeps every plane non-empty.
    """
    height, width, channels = _image_shape(sizes)
    factor = 1
    while (
        factor < min(height, width)
        and _render_bytes(height // factor, width // factor, channels) > MAX_PREVIEW_BYTES
    ):
        factor += 1
    return factor


def _image_shape(sizes: Mapping[str, int]) -> tuple[int, int, int]:
    """Height, width, and channel count, each defaulting to 1 when the file has no such axis."""
    return sizes.get("Y", 1), sizes.get("X", 1), sizes.get("C", 1)


def _render_bytes(height: int, width: int, channels: int) -> int:
    per_pixel = _PREVIEW_BYTES_PER_PIXEL + _PREVIEW_BYTES_PER_CHANNEL_PIXEL * channels
    return height * width * per_pixel


def _shrink_planes(planes: list[NDArray[Any]], factor: int) -> list[NDArray[Any]]:
    """Shrink each plane in place, so a full-size plane is freed before the next."""
    for index, plane in enumerate(planes):
        planes[index] = _shrink_plane(plane, factor)
    return planes


def _shrink_plane(plane: NDArray[Any], factor: int) -> NDArray[Any]:
    """Average `factor` x `factor` blocks of pixels, in the plane's own pixel type.

    A remainder of rows or columns smaller than a block is dropped. Splitting an
    axis never copies, and the reduction casts in chunks, so no full-size float
    copy is made.
    """
    if factor == 1:
        return plane
    rows, columns = plane.shape[0] // factor, plane.shape[1] // factor
    blocks = plane[: rows * factor, : columns * factor].reshape(rows, factor, columns, factor)
    mean = blocks.mean(axis=(1, 3), dtype=np.float64)
    if np.issubdtype(plane.dtype, np.integer):
        mean = np.rint(mean)
    return mean.astype(plane.dtype)


def _preview_planes(nd2f: nd2.ND2File, sizes: dict[str, int]) -> list[NDArray[Any]]:
    """Max-project Z and keep the first index of every other leading axis.

    Each `read_frame` call returns every channel at one stack position, so
    memory grows with the frame size, not with the number of frames.
    """
    return _reduce_loops(nd2f.read_frame, list(nd2f.loop_indices), sizes)


def _reduce_loops(
    read_frame: Callable[[int], NDArray[Any]],
    loops: list[dict[str, int]],
    sizes: dict[str, int],
) -> list[NDArray[Any]]:
    if sizes.get("S", 1) > 1:
        raise ValueError(RGB_NOT_SUPPORTED_MESSAGE)
    n_channels = sizes.get("C", 1)
    first_axes = [axis for axis in sizes if axis not in {"C", "Y", "X", "Z"}]
    # `loop_indices` holds only T, P, Z, and U; channels arrive inside each frame.
    to_read = [
        index
        for index, loop in enumerate(loops)
        if all(loop.get(axis, 0) == 0 for axis in first_axes)
    ]
    # Planes stay in the file's pixel type. A float64 copy of every channel
    # was most of the peak memory.
    accum: list[NDArray[Any] | None] = [None] * n_channels
    for done, index in enumerate(to_read):
        check_deadline(f"reading frame {done + 1} of {len(to_read)}")
        # The frame has no name in this scope, so `_max_into` is its last holder
        # and it is freed before the next, possibly full-size, frame is decoded.
        _max_into(accum, read_frame(index))
    if any(plane is None for plane in accum):
        raise ValueError(f"ND2 file is missing a channel plane: {_format_sizes(sizes)}")
    return [plane for plane in accum if plane is not None]


def _max_into(accum: list[NDArray[Any] | None], frame: NDArray[Any]) -> None:
    """Fold one frame into the running per-channel maximum."""
    n_channels = len(accum)
    for channel in range(n_channels):
        plane = _channel_plane(frame, channel, n_channels)
        current = accum[channel]
        if current is None:
            accum[channel] = plane.copy()
        else:
            np.maximum(current, plane, out=current)


def _format_sizes(sizes: dict[str, int]) -> str:
    return ", ".join(f"{key}={value}" for key, value in sizes.items())


def _channel_plane(frame: NDArray[Any], channel_index: int, n_channels: int) -> NDArray[Any]:
    arr = np.asarray(frame)
    if arr.ndim == 2 and n_channels == 1:
        return arr
    if arr.ndim == 3 and arr.shape[0] == n_channels:
        return arr[channel_index]
    if arr.ndim == 3 and arr.shape[-1] == n_channels:
        return arr[..., channel_index]
    raise ValueError(f"Unexpected ND2 frame shape {arr.shape}")
