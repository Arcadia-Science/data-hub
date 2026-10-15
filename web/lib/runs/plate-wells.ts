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

export interface PlateLayout<W> {
  byPos: Map<string, W>;
  cols: number;
  rows: number;
  // Wells whose label is not a plate position such as `A1`. The grid lists
  // them apart from the plate instead of dropping them.
  unplaced: W[];
}

export function plateCellKey(row: number, col: number): string {
  return `${row}-${col}`;
}

// Places each well on a row and column from its label. The grid is as large as
// the furthest well, so a 96-well and a 384-well plate both fit.
export function buildPlateLayout<W extends { well: string }>(
  wells: readonly W[]
): PlateLayout<W> {
  let maxRow = 0;
  let maxCol = 0;
  const byPos = new Map<string, W>();
  const unplaced: W[] = [];
  for (const well of wells) {
    const pos = parseWellPosition(well.well);
    if (!pos) {
      unplaced.push(well);
      continue;
    }
    maxRow = Math.max(maxRow, pos.row);
    maxCol = Math.max(maxCol, pos.col);
    byPos.set(plateCellKey(pos.row, pos.col), well);
  }
  return { rows: maxRow + 1, cols: maxCol + 1, byPos, unplaced };
}

export interface PlateCell {
  col: number;
  row: number;
}

interface PlateShape {
  cols: number;
  has: (row: number, col: number) => boolean;
  rows: number;
}

// Walks from (row, col) one step at a time and returns the first occupied
// cell, so a gap in the plate does not trap the keyboard.
function scan(
  shape: PlateShape,
  start: PlateCell,
  step: PlateCell
): PlateCell | null {
  let { row, col } = start;
  while (row >= 0 && row < shape.rows && col >= 0 && col < shape.cols) {
    if (shape.has(row, col)) {
      return { row, col };
    }
    row += step.row;
    col += step.col;
  }
  return null;
}

/**
 * Where a key press moves focus on a plate. Arrow keys move to the next well in
 * that direction, Home and End to the first and last well in the row, and
 * Ctrl with Home or End to the first and last well on the plate. Returns null
 * when the key does nothing here or no well lies that way.
 */
export function nextPlateCell(
  shape: PlateShape,
  from: PlateCell,
  key: string,
  ctrlKey = false
): PlateCell | null {
  switch (key) {
    case "ArrowRight":
      return scan(
        shape,
        { row: from.row, col: from.col + 1 },
        { row: 0, col: 1 }
      );
    case "ArrowLeft":
      return scan(
        shape,
        { row: from.row, col: from.col - 1 },
        { row: 0, col: -1 }
      );
    case "ArrowDown":
      return scan(
        shape,
        { row: from.row + 1, col: from.col },
        { row: 1, col: 0 }
      );
    case "ArrowUp":
      return scan(
        shape,
        { row: from.row - 1, col: from.col },
        { row: -1, col: 0 }
      );
    case "Home":
      if (!ctrlKey) {
        return scan(shape, { row: from.row, col: 0 }, { row: 0, col: 1 });
      }
      for (let row = 0; row < shape.rows; row++) {
        const found = scan(shape, { row, col: 0 }, { row: 0, col: 1 });
        if (found) {
          return found;
        }
      }
      return null;
    case "End":
      if (!ctrlKey) {
        return scan(
          shape,
          { row: from.row, col: shape.cols - 1 },
          { row: 0, col: -1 }
        );
      }
      for (let row = shape.rows - 1; row >= 0; row--) {
        const found = scan(
          shape,
          { row, col: shape.cols - 1 },
          { row: 0, col: -1 }
        );
        if (found) {
          return found;
        }
      }
      return null;
    default:
      return null;
  }
}
