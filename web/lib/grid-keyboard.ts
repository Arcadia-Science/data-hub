export interface GridCell {
  col: number;
  row: number;
}

export interface GridShape {
  cols: number;
  has: (row: number, col: number) => boolean;
  rows: number;
}

// Keys `nextGridCell` can act on. A handler calls `preventDefault` for all of
// them, even when focus stays put, so the page behind never scrolls instead.
const GRID_KEYS = new Set([
  "ArrowRight",
  "ArrowLeft",
  "ArrowDown",
  "ArrowUp",
  "Home",
  "End",
]);

export function isGridKey(event: {
  altKey: boolean;
  key: string;
  metaKey: boolean;
}): boolean {
  return GRID_KEYS.has(event.key) && !event.altKey && !event.metaKey;
}

// Walks from `start` one step at a time and returns the first occupied cell, so
// a gap in the grid does not trap the keyboard.
function scan(
  shape: GridShape,
  start: GridCell,
  step: GridCell
): GridCell | null {
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

// The first well, in reading order, of the nearest row that has one, going
// down or up from `startRow`. A well alone in its row is reached this way.
function wrapToRow(
  shape: GridShape,
  startRow: number,
  direction: 1 | -1
): GridCell | null {
  for (let row = startRow; row >= 0 && row < shape.rows; row += direction) {
    const found =
      direction === 1
        ? scan(shape, { row, col: 0 }, { row: 0, col: 1 })
        : scan(shape, { row, col: shape.cols - 1 }, { row: 0, col: -1 });
    if (found) {
      return found;
    }
  }
  return null;
}

// The same for columns: the top (or bottom) well of the nearest column that
// has one, going right or left from `startCol`.
function wrapToColumn(
  shape: GridShape,
  startCol: number,
  direction: 1 | -1
): GridCell | null {
  for (let col = startCol; col >= 0 && col < shape.cols; col += direction) {
    const found =
      direction === 1
        ? scan(shape, { row: 0, col }, { row: 1, col: 0 })
        : scan(shape, { row: shape.rows - 1, col }, { row: -1, col: 0 });
    if (found) {
      return found;
    }
  }
  return null;
}

/**
 * Where a key press moves focus on a grid with gaps, such as a plate. Arrow
 * keys move to the next occupied cell in that direction. When nothing lies that
 * way, Left and Right continue into the nearest row above or below, and Up and
 * Down into the nearest column to the left or right, so no well is out of
 * reach. Home and End jump to the first and last well in the row, and Ctrl with
 * Home or End to the first and last well in the grid. Returns null when the
 * key does nothing here.
 */
export function nextGridCell(
  shape: GridShape,
  from: GridCell,
  key: string,
  ctrlKey = false
): GridCell | null {
  switch (key) {
    case "ArrowRight":
      return (
        scan(shape, { row: from.row, col: from.col + 1 }, { row: 0, col: 1 }) ??
        wrapToRow(shape, from.row + 1, 1)
      );
    case "ArrowLeft":
      return (
        scan(
          shape,
          { row: from.row, col: from.col - 1 },
          { row: 0, col: -1 }
        ) ?? wrapToRow(shape, from.row - 1, -1)
      );
    case "ArrowDown":
      return (
        scan(shape, { row: from.row + 1, col: from.col }, { row: 1, col: 0 }) ??
        wrapToColumn(shape, from.col + 1, 1)
      );
    case "ArrowUp":
      return (
        scan(
          shape,
          { row: from.row - 1, col: from.col },
          { row: -1, col: 0 }
        ) ?? wrapToColumn(shape, from.col - 1, -1)
      );
    case "Home":
      return ctrlKey
        ? wrapToRow(shape, 0, 1)
        : scan(shape, { row: from.row, col: 0 }, { row: 0, col: 1 });
    case "End":
      return ctrlKey
        ? wrapToRow(shape, shape.rows - 1, -1)
        : scan(
            shape,
            { row: from.row, col: shape.cols - 1 },
            { row: 0, col: -1 }
          );
    default:
      return null;
  }
}
