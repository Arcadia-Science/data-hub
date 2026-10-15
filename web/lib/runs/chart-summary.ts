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
  // A missing column parses to NaN, which would poison every minimum and
  // maximum, so only points with real numbers describe the curve.
  const finite = points.filter(
    (point) => Number.isFinite(point.x) && Number.isFinite(point.y)
  );
  if (finite.length === 0) {
    return `${label}: no data.`;
  }
  let minX = finite[0].x;
  let maxX = finite[0].x;
  let minY = finite[0].y;
  let maxY = finite[0].y;
  let xAtMax = finite[0].x;
  for (const point of finite) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    if (point.y > maxY) {
      maxY = point.y;
      xAtMax = point.x;
    }
  }
  const count = finite.length;
  return `${label}: ${count.toLocaleString("en-US")} ${count === 1 ? "point" : "points"}. ${xLabel} runs from ${formatSummaryNumber(minX)} to ${formatSummaryNumber(maxX)}. Values range from ${formatSummaryNumber(minY)} to ${formatSummaryNumber(maxY)}, highest at ${formatSummaryNumber(xAtMax)}.`;
}
