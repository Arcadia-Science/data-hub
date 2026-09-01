import { memo } from "react";
import {
  SPARKLINE_HEIGHT,
  SPARKLINE_WIDTH,
  type SparklineGeometry,
} from "@/lib/runs/plate-wells";
import type { QpcrMeltingSeriesMeta } from "@/lib/runs/qpcr-melting";

export interface QpcrMeltingSparklineLine {
  geometry: SparklineGeometry;
  meta: QpcrMeltingSeriesMeta;
}

// Memoized because one channel renders up to 384 of these and the grid above
// re-renders whenever the series toggle changes or the well dialog opens.
export const QpcrMeltingSparkline = memo(function QpcrMeltingSparkline({
  lines,
}: {
  lines: readonly QpcrMeltingSparklineLine[];
}) {
  const drawable = lines.filter((line) => line.geometry.d);
  if (drawable.length === 0) {
    return <div className="h-full min-h-12 w-full" />;
  }

  return (
    <svg
      aria-hidden
      className="h-full w-full"
      preserveAspectRatio="none"
      viewBox={`0 0 ${SPARKLINE_WIDTH} ${SPARKLINE_HEIGHT}`}
    >
      <title>{drawable.map((line) => line.meta.label).join(", ")}</title>
      {/* Each series is scaled to the tile on its own, so a melt transition
          and the derivative peak it produces line up on the x-axis despite
          having nothing in common on the y-axis. */}
      {drawable.map((line) => (
        <path
          d={line.geometry.d}
          fill="none"
          key={line.meta.id}
          stroke={line.meta.color}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.75"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
});
