"""Parse an Azure Cielo `_MeltingCurve.csv` into tidy derivatives and a plate JSON.

Vendor temperatures are centidegrees C. Peak finding is left to downstream
tools; this module only computes `-dF/dT` and `-dF%/dT`.
"""

from __future__ import annotations
import csv
import json
from dataclasses import dataclass, field
from pathlib import Path

# Four channels × 96 wells at this cap lands near Aunty's ~270 KB plate JSON.
MAX_POINTS_PER_WELL = 24

_TIDY_FIELDNAMES = [
    "channel",
    "well",
    "temperature_c",
    "fluorescence",
    "fluorescence_pct_max",
    "neg_dF_dT",
    "neg_dFpct_dT",
]


@dataclass
class ChannelBlock:
    channel: str
    wells: dict[str, list[tuple[float, float]]] = field(default_factory=dict)


@dataclass
class ParsedMeltingCurve:
    blocks: list[ChannelBlock]
    tidy_rows: list[dict[str, object]]
    plate: dict[str, object]


def is_melting_curve_filename(filename: str) -> bool:
    return filename.lower().endswith("_meltingcurve.csv")


def parse_melting_curve_csv(path: Path) -> list[ChannelBlock]:
    """Parse stacked `ChannelN MeltingCurveData` blocks into per-well series."""
    blocks: list[ChannelBlock] = []
    current: ChannelBlock | None = None
    well_cols: list[str] = []

    with open(path, newline="", encoding="utf-8-sig") as fh:
        reader = csv.reader(fh)
        for row in reader:
            if not row:
                continue
            first = row[0].strip()
            if first.endswith("MeltingCurveData"):
                channel = first.split()[0]
                well_cols = [c for c in row[1:] if c]
                current = ChannelBlock(channel=channel)
                for well in well_cols:
                    current.wells[well] = []
                blocks.append(current)
                continue
            if current is None:
                continue
            try:
                temp_c = float(first) / 100.0
            except ValueError:
                continue
            for i, well in enumerate(well_cols):
                cell = row[1 + i] if 1 + i < len(row) else ""
                if cell == "":
                    continue
                current.wells[well].append((temp_c, float(cell)))

    if not blocks:
        raise ValueError(f"No 'MeltingCurveData' channel blocks found in {path}")
    return blocks


def _gradient(values: list[float], xs: list[float]) -> list[float]:
    """One-dimensional central difference, matching `numpy.gradient` on a 1-D line."""
    n = len(values)
    if n == 0:
        return []
    if n == 1:
        return [0.0]
    out = [0.0] * n
    out[0] = (values[1] - values[0]) / (xs[1] - xs[0])
    out[-1] = (values[-1] - values[-2]) / (xs[-1] - xs[-2])
    for i in range(1, n - 1):
        out[i] = (values[i + 1] - values[i - 1]) / (xs[i + 1] - xs[i - 1])
    return out


def _derivatives(
    temps: list[float], fluor: list[float]
) -> tuple[list[float], list[float], list[float]]:
    """Returns (pct_of_max, -dF/dT, -d(pct_of_max)/dT)."""
    max_f = max(fluor) if fluor and max(fluor) != 0 else 1.0
    pct = [f / max_f * 100.0 for f in fluor]
    neg_df_dt = [-g for g in _gradient(fluor, temps)]
    neg_dfpct_dt = [-g for g in _gradient(pct, temps)]
    return pct, neg_df_dt, neg_dfpct_dt


def build_tidy_rows(blocks: list[ChannelBlock]) -> list[dict[str, object]]:
    """One row per (channel, well, temperature)."""
    rows: list[dict[str, object]] = []
    for block in blocks:
        for well, pts in block.wells.items():
            if not pts:
                continue
            temps = [t for t, _ in pts]
            fluor = [f for _, f in pts]
            pct, neg_df_dt, neg_dfpct_dt = _derivatives(temps, fluor)
            for i in range(len(pts)):
                rows.append(
                    {
                        "channel": block.channel,
                        "well": well,
                        "temperature_c": round(temps[i], 2),
                        "fluorescence": round(fluor[i], 4),
                        "fluorescence_pct_max": round(pct[i], 4),
                        "neg_dF_dT": round(neg_df_dt[i], 5),
                        "neg_dFpct_dT": round(neg_dfpct_dt[i], 5),
                    }
                )
    return rows


def write_tidy_csv(path: Path, rows: list[dict[str, object]]) -> None:
    with open(path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=_TIDY_FIELDNAMES)
        writer.writeheader()
        writer.writerows(rows)


def _thin(points: list[tuple[float, float]], cap: int) -> list[tuple[float, float]]:
    if len(points) <= cap:
        return points
    step = len(points) / cap
    idx = sorted({round(i * step) for i in range(cap)})
    idx = [min(i, len(points) - 1) for i in idx]
    return [points[i] for i in idx]


def build_plate_json(blocks: list[ChannelBlock]) -> dict[str, object]:
    """Thinned per-channel, per-well `-dF%/dT` points for the plate sparklines."""
    channels_out: list[dict[str, object]] = []
    for block in blocks:
        wells_out: list[dict[str, object]] = []
        for well, pts in block.wells.items():
            if not pts:
                continue
            temps = [t for t, _ in pts]
            fluor = [f for _, f in pts]
            _pct, _neg_df_dt, neg_dfpct_dt = _derivatives(temps, fluor)
            series = list(zip(temps, neg_dfpct_dt, strict=True))
            thinned = _thin(series, MAX_POINTS_PER_WELL)
            wells_out.append(
                {
                    "well": well,
                    "points": [{"x": round(x, 3), "y": round(y, 4)} for x, y in thinned],
                }
            )
        channels_out.append({"channel": block.channel, "wells": wells_out})
    return {"channels": channels_out}


def write_plate_json(path: Path, blocks: list[ChannelBlock]) -> None:
    path.write_text(json.dumps(build_plate_json(blocks), allow_nan=False), encoding="utf-8")


def parse_melting_curve_file(path: Path) -> ParsedMeltingCurve:
    blocks = parse_melting_curve_csv(path)
    tidy_rows = build_tidy_rows(blocks)
    plate = build_plate_json(blocks)
    return ParsedMeltingCurve(blocks=blocks, tidy_rows=tidy_rows, plate=plate)
