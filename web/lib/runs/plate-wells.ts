// Plate geometry shared by every well-plate report (Aunty, qPCR melting).
// Kept instrument-agnostic so a new plate viewer does not have to import from
// another instrument's module.

export interface PlatePoint {
  x: number;
  y: number;
}

export function parseWellPosition(
  well: string
): { col: number; row: number } | null {
  const match = /^([A-P])(\d{1,2})$/i.exec(well.trim());
  if (!match) {
    return null;
  }
  return {
    row: match[1].toUpperCase().charCodeAt(0) - 65,
    col: Number.parseInt(match[2], 10) - 1,
  };
}

export function compareWells(a: string, b: string): number {
  const pa = parseWellPosition(a);
  const pb = parseWellPosition(b);
  if (pa && pb) {
    return pa.row - pb.row || pa.col - pb.col;
  }
  return a.localeCompare(b);
}

export const SPARKLINE_WIDTH = 120;
export const SPARKLINE_HEIGHT = 72;
export const SPARKLINE_PAD = 6;

export interface SparklineGeometry {
  d: string;
  markerX: number | null;
}

// Scales a curve into the sparkline viewBox. `markerX` is dropped when it
// falls outside the curve's own x range.
export function sparklineGeometry(
  points: readonly PlatePoint[],
  markerX?: number | null
): SparklineGeometry {
  if (points.length === 0) {
    return { d: "", markerX: null };
  }
  let minX = points[0].x;
  let maxX = points[0].x;
  let minY = points[0].y;
  let maxY = points[0].y;
  for (const p of points) {
    if (p.x < minX) {
      minX = p.x;
    }
    if (p.x > maxX) {
      maxX = p.x;
    }
    if (p.y < minY) {
      minY = p.y;
    }
    if (p.y > maxY) {
      maxY = p.y;
    }
  }
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const innerW = SPARKLINE_WIDTH - SPARKLINE_PAD * 2;
  const innerH = SPARKLINE_HEIGHT - SPARKLINE_PAD * 2;

  function sx(x: number): number {
    return SPARKLINE_PAD + ((x - minX) / spanX) * innerW;
  }
  function sy(y: number): number {
    return SPARKLINE_PAD + (1 - (y - minY) / spanY) * innerH;
  }

  const d = points
    .map(
      (p, i) =>
        `${i === 0 ? "M" : "L"}${sx(p.x).toFixed(2)} ${sy(p.y).toFixed(2)}`
    )
    .join(" ");

  const marker =
    markerX == null || markerX < minX || markerX > maxX ? null : sx(markerX);
  return { d, markerX: marker };
}
