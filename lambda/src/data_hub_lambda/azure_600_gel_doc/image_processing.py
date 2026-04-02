from __future__ import annotations
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import skimage as ski
import tifffile
from matplotlib.figure import Figure
from numpy.typing import NDArray


class ImageOperation:
    """A callable wrapper for image processing functions."""

    def __init__(self, method: Callable, *args, **kwargs):  # type: ignore[type-arg]
        self.method = method
        self.args = args
        self.kwargs = kwargs

    def __call__(self, intensities: NDArray) -> NDArray:  # type: ignore[type-arg]
        return self.method(intensities, *self.args, **self.kwargs)

    def __repr__(self) -> str:
        args_repr = [repr(arg) for arg in self.args]
        kwargs_repr = [f"{key}={repr(value)}" for key, value in self.kwargs.items()]
        args_kwargs_repr = ", ".join(args_repr + kwargs_repr)
        return f"{self.method.__name__}({args_kwargs_repr})"


@dataclass
class Pipeline:
    """A sequence of image processing operations."""

    operations: list[ImageOperation]

    def __call__(self, intensities: NDArray) -> NDArray:  # type: ignore[type-arg]
        out = intensities.copy()
        for operation in self.operations:
            out = operation(out)
        return out


def rescale_grayscale_intensities(
    intensities: NDArray,  # type: ignore[type-arg]
    percentile_range: tuple[float, float] = (0, 100),
    out_range: tuple[float, float] = (0, 1),
) -> NDArray:  # type: ignore[type-arg]
    """Rescale image intensities using percentile-based contrast stretching."""
    if not (0 <= percentile_range[0] < percentile_range[1] <= 100):
        raise ValueError(
            f"Invalid percentile range: {percentile_range}. "
            f"Values must be in ascending order between 0 and 100."
        )
    if intensities.size == 0:
        return np.zeros_like(intensities, dtype=float)
    if np.min(intensities) == np.max(intensities):
        return np.full_like(intensities, out_range[0], dtype=float)

    p1, p2 = np.percentile(intensities, percentile_range)
    return ski.exposure.rescale_intensity(
        intensities,
        in_range=(p1, p2),  # type: ignore[arg-type]
        out_range=out_range,  # type: ignore[arg-type]
    )


def rescale_rgb_intensities(
    intensities: NDArray,  # type: ignore[type-arg]
    percentile_range: tuple[float, float] = (0, 100),
    out_range: tuple[float, float] = (0, 1),
) -> NDArray:  # type: ignore[type-arg]
    """Rescale RGB image intensities channel-wise."""
    if intensities.ndim < 3 or not (3 <= intensities.shape[-1] <= 4):
        raise ValueError(
            f"Expected RGB/RGBA image with 3 or 4 channels, got shape {intensities.shape}"
        )

    rescaled_rgb = np.zeros_like(intensities)
    for c in range(3):
        rescaled_rgb[..., c] = rescale_grayscale_intensities(
            intensities[..., c], percentile_range, out_range
        )
    return rescaled_rgb


class TIFFProcessor:
    def __init__(self, path: Path):
        self.path = path
        self._intensities: NDArray | None = None  # type: ignore[type-arg]
        self._is_rgb: bool | None = None
        self._num_pages: int | None = None
        self.is_multi_page: bool | None = None

    def load(self) -> None:
        if not self.path.exists():
            raise FileNotFoundError(f"TIFF file not found: {self.path}")
        if self.path.suffix.lower() not in [".tiff", ".tif"]:
            raise ValueError(f"Expected TIFF file (.tif/.tiff), got: {self.path.suffix}")

        self._intensities = tifffile.imread(self.path)
        self._is_rgb = self._infer_rgb(self._intensities)
        self._num_pages = self._get_page_count(self.path)
        self.is_multi_page = self._num_pages > 1

    @property
    def intensities(self) -> NDArray:  # type: ignore[type-arg]
        if self._intensities is None:
            raise RuntimeError("Call load() first.")
        return self._intensities

    @property
    def is_rgb(self) -> bool:
        if self._is_rgb is None:
            raise RuntimeError("Call load() first.")
        return self._is_rgb

    @property
    def num_pages(self) -> int:
        if self._num_pages is None:
            raise RuntimeError("Call load() first.")
        return self._num_pages

    @property
    def pipeline(self) -> Pipeline:
        if self.is_rgb:
            return Pipeline(
                [
                    ImageOperation(
                        rescale_rgb_intensities, percentile_range=(1, 99), out_range=(0, 255)
                    )
                ]
            )
        else:
            return Pipeline(
                [ImageOperation(rescale_grayscale_intensities, percentile_range=(1, 99))]
            )

    def generate_figure(self) -> Figure:
        processed = self.pipeline(self.intensities)
        if not self.is_multi_page:
            processed = processed[np.newaxis, ...]

        colormap = "Greys_r" if not self.is_rgb else None
        fig, axes = plt.subplots(
            ncols=self.num_pages,
            figsize=(5 * self.num_pages, 4),
            squeeze=False,
            sharex=True,
            sharey=True,
            layout="constrained",
        )

        for i in range(self.num_pages):
            axes[0, i].imshow(processed[i], cmap=colormap)

        fig.suptitle(self.path.name)
        [ax.axis("off") for ax in axes.flat]
        return fig

    def export_figure(self) -> Path:
        figure = self.generate_figure()
        png_path = self.path.parent / (self.path.stem + ".png")
        figure.savefig(png_path, dpi=300)
        return png_path

    @staticmethod
    def _infer_rgb(intensities: NDArray) -> bool:  # type: ignore[type-arg]
        return intensities.ndim >= 3 and intensities.shape[-1] == 3

    @staticmethod
    def _get_page_count(path: Path) -> int:
        with tifffile.TiffFile(path) as tiff:
            num_pages = len(tiff.pages)
        return num_pages
