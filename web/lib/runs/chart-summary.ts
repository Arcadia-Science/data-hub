export interface CurvePoint {
  x: number;
  y: number;
}

// Four significant digits, no trailing zeros, no exponent for ordinary
// values. Fixed to US formatting so server and browser agree.
export function formatSummaryNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return String(value);
  }
  if (Number.isInteger(value)) {
    return value.toLocaleString("en-US");
  }
  const rounded = Number(value.toPrecision(4));
  return rounded.toLocaleString("en-US", { maximumFractionDigits: 20 });
}

/**
 * One sentence of plain text describing a curve, for people who cannot see the
 * chart: how many points it has, where the x axis starts and ends, how far the
 * values range, and where the highest value sits.
 */
export function describeCurve({
  label,
  points,
  xLabel,
}: {
  label: string;
  points: readonly CurvePoint[];
  xLabel: string;
}): string {
  if (points.length === 0) {
    return `${label}: no data.`;
  }
  let minX = points[0].x;
  let maxX = points[0].x;
  let minY = points[0].y;
  let maxY = points[0].y;
  let xAtMax = points[0].x;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    if (point.y > maxY) {
      maxY = point.y;
      xAtMax = point.x;
    }
  }
  const count = points.length;
  return `${label}: ${count.toLocaleString("en-US")} ${count === 1 ? "point" : "points"}. ${xLabel} runs from ${formatSummaryNumber(minX)} to ${formatSummaryNumber(maxX)}. Values range from ${formatSummaryNumber(minY)} to ${formatSummaryNumber(maxY)}, highest at ${formatSummaryNumber(xAtMax)}.`;
}
