import { memo } from "react";
import {
  type AuntySeriesMeta,
  SPARKLINE_HEIGHT,
  SPARKLINE_PAD,
  SPARKLINE_WIDTH,
  type SparklineGeometry,
  TM_MARKER_COLOR,
} from "@/lib/runs/aunty";

// Memoized because one plate renders up to 384 of these and the grid above it
// re-renders whenever the series toggle changes.
export const AuntySparkline = memo(function AuntySparkline({
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
      viewBox={`0 0 ${SPARKLINE_WIDTH} ${SPARKLINE_HEIGHT}`}
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
          y1={SPARKLINE_PAD}
          y2={SPARKLINE_HEIGHT - SPARKLINE_PAD}
        />
      )}
    </svg>
  );
});
