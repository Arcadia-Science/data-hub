import { memo } from "react";
import {
  SPARKLINE_HEIGHT,
  SPARKLINE_WIDTH,
  type SparklineGeometry,
} from "@/lib/runs/aunty";

const LINE_COLOR = "#0d9488";

export const QpcrMeltingSparkline = memo(function QpcrMeltingSparkline({
  geometry,
  label,
}: {
  geometry?: SparklineGeometry;
  label: string;
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
      <title>{label}</title>
      <path
        d={geometry.d}
        fill="none"
        stroke={LINE_COLOR}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.75"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
});
