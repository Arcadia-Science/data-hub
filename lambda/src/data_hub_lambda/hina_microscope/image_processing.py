from __future__ import annotations
import logging
from pathlib import Path
from types import SimpleNamespace

import nd2
import numpy as np
import skimage as ski
from arcadia_microscopy_tools.blending import overlay_channels
from arcadia_microscopy_tools.channels import BRIGHTFIELD, Channel
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
        self._image: SimpleNamespace | None = None
        self._planes: list[NDArray[np.float64]] | None = None

    def load(self) -> None:
        if not self.path.exists():
            raise FileNotFoundError(f"ND2 file not found: {self.path}")
        if self.path.suffix.lower() not in ND2_SUFFIXES:
            raise ValueError(f"Expected ND2 file (.nd2), got: {self.path.suffix}")

        # Metadata only. `from_nd2_path` would decode every pixel into memory.
        metadata = _instrument_metadata(self.path)
        self._planes = _preview_planes(self.path, metadata.sizes)
        self._image = SimpleNamespace(
            sizes=metadata.sizes,
            channels=[item.channel for item in metadata.channel_metadata_list],
            dimensions=metadata.dimensions,
        )

    @property
    def image(self) -> SimpleNamespace:
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


def _instrument_metadata(path: Path):  # type: ignore[no-untyped-def]
    """Read ND2 metadata without decoding pixels.

    `parse_nd2` is the public helper in newer microscopy tools. The locked
    0.4.1 release only exposes the parser class.
    """
    try:
        from arcadia_microscopy_tools.nikon import parse_nd2
    except ImportError:
        from arcadia_microscopy_tools.nikon import _NikonMetadataParser

        return _NikonMetadataParser(path).parse()
    return parse_nd2(path)


def _preview_planes(path: Path, sizes: dict[str, int]) -> list[NDArray[np.float64]]:
    """Max-project Z and keep the first index of every other leading axis.

    Each `read_frame` call is one plane, so the decoded image never has to
    fit in memory at once.
    """
    with nd2.ND2File(path) as nd2f:
        loops = list(nd2f.loop_indices)
        total = len(loops) or 1
        if not loops:
            check_deadline(f"reading frame 1 of {total}")
            frame = nd2f.read_frame(0)
            count = sizes.get("C", 1)
            return [_channel_plane(frame, index, count) for index in range(count)]
        return _reduce_loops(nd2f.read_frame, loops, sizes, total)


def _reduce_loops(
    read_frame,  # type: ignore[no-untyped-def]
    loops: list[dict[str, int]],
    sizes: dict[str, int],
    total: int,
) -> list[NDArray[np.float64]]:
    n_channels = sizes.get("C", 1)
    first_axes = [axis for axis in sizes if axis not in {"C", "Y", "X", "Z"}]
    accum: list[NDArray[np.float64] | None] = [None] * n_channels
    for index, loop in enumerate(loops):
        if any(loop.get(axis, 0) != 0 for axis in first_axes):
            continue
        check_deadline(f"reading frame {index + 1} of {total}")
        frame = read_frame(index)
        if "C" in loop:
            planes = [(int(loop["C"]), _channel_plane(frame, 0, 1))]
        else:
            planes = [
                (channel, _channel_plane(frame, channel, n_channels))
                for channel in range(n_channels)
            ]
        for channel, plane in planes:
            current = accum[channel]
            if current is None:
                accum[channel] = plane
            else:
                np.maximum(current, plane, out=current)
    if any(plane is None for plane in accum):
        raise ValueError(f"ND2 file is missing a channel plane: {path_sizes(sizes)}")
    return [plane for plane in accum if plane is not None]


def path_sizes(sizes: dict[str, int]) -> str:
    return ", ".join(f"{key}={value}" for key, value in sizes.items())


def _channel_plane(frame: NDArray, channel_index: int, n_channels: int) -> NDArray[np.float64]:  # type: ignore[type-arg]
    arr = np.asarray(frame)
    if arr.ndim == 2:
        return arr.astype(np.float64, copy=False)
    if arr.ndim == 3 and arr.shape[0] == n_channels:
        return arr[channel_index].astype(np.float64, copy=False)
    if arr.ndim == 3 and arr.shape[-1] == n_channels:
        return arr[..., channel_index].astype(np.float64, copy=False)
    raise ValueError(f"Unexpected ND2 frame shape {arr.shape}")
