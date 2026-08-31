import { memo } from "react";
import {
  SPARKLINE_HEIGHT,
  SPARKLINE_WIDTH,
  type SparklineGeometry,
} from "@/lib/runs/plate-wells";
import type { QpcrMeltingSeriesMeta } from "@/lib/runs/qpcr-melting";

// Memoized because one channel renders up to 384 of these and the grid above
// re-renders whenever the series toggle changes or the well dialog opens.
export const QpcrMeltingSparkline = memo(function QpcrMeltingSparkline({
  geometry,
  meta,
}: {
  geometry?: SparklineGeometry;
  meta: QpcrMeltingSeriesMeta;
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
    </svg>
  );
});
