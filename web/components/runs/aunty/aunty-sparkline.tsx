import {
  type AuntyPoint,
  type AuntySeriesMeta,
  TM_MARKER_COLOR,
} from "@/lib/runs/aunty";

const WIDTH = 120;
const HEIGHT = 72;
const PAD = 6;

export interface SparklineGeometry {
  d: string;
  markerX: number | null;
}

export function sparklineGeometry(
  points: AuntyPoint[],
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
  const innerW = WIDTH - PAD * 2;
  const innerH = HEIGHT - PAD * 2;

  function sx(x: number): number {
    return PAD + ((x - minX) / spanX) * innerW;
  }
  function sy(y: number): number {
    return PAD + (1 - (y - minY) / spanY) * innerH;
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

export function AuntySparkline({
  geometry,
  meta,
}: {
  geometry?: SparklineGeometry;
  meta: AuntySeriesMeta;
}) {
  if (!geometry?.d) {
    return <div className="h-full min-h-12 w-full" />;
  }

  return (
    <svg
      aria-hidden
      className="h-full w-full"
      preserveAspectRatio="none"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
    >
      <title>{meta.label}</title>
      <path
        d={geometry.d}
        fill="none"
        stroke={meta.color}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.75"
        vectorEffect="non-scaling-stroke"
      />
      {geometry.markerX != null && (
        <line
          stroke={TM_MARKER_COLOR}
          strokeDasharray="3 2"
          strokeWidth="1.25"
          vectorEffect="non-scaling-stroke"
          x1={geometry.markerX}
          x2={geometry.markerX}
          y1={PAD}
          y2={HEIGHT - PAD}
        />
      )}
    </svg>
  );
}
