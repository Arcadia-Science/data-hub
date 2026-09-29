"""Write an uncompressed RGB TIFF stack of about a requested size."""

from __future__ import annotations
from pathlib import Path

import numpy as np
import tifffile

# Small pages keep a multi-gigabyte stack from holding the whole file in memory.
_FRAME_SHAPE = (64, 64, 3)


def write_synthetic_tiff_stack(dest: Path, target_bytes: int) -> int:
    """Write pages until *dest* is at least *target_bytes*. Return the byte size.

    The stack is uncompressed uint8 RGB, which is what DishCam encoding expects.
    """
    if target_bytes < 1:
        raise ValueError("target_bytes must be at least 1")
    dest.parent.mkdir(parents=True, exist_ok=True)
    frame = np.zeros(_FRAME_SHAPE, dtype=np.uint8)
    with tifffile.TiffWriter(dest, bigtiff=True) as writer:
        while True:
            writer.write(frame, photometric="rgb")
            size = dest.stat().st_size
            if size >= target_bytes:
                return size
