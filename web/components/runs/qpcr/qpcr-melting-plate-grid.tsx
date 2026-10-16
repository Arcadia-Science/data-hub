"use client";

import { memo, useCallback, useMemo } from "react";
import { PlateGrid } from "@/components/runs/plate-grid";
import { usePlateWellsActions } from "@/components/runs/plate-wells-provider";
import {
  QpcrMeltingSparkline,
  type QpcrMeltingSparklineLine,
} from "@/components/runs/qpcr/qpcr-melting-sparkline";
import { sparklineGeometry } from "@/lib/runs/plate-wells";
import {
  QPCR_MELTING_SERIES_META,
  type QpcrMeltingChannel,
  type QpcrMeltingSeriesId,
} from "@/lib/runs/qpcr-melting";

const NO_LINES: readonly QpcrMeltingSparklineLine[] = [];

// Memoized so opening or closing the well dialog does not re-render up to 384
// sparklines behind it.
export const QpcrMeltingPlateGrid = memo(function QpcrMeltingPlateGrid({
  channel,
  onWellClick,
  seriesIds,
}: {
  channel: QpcrMeltingChannel;
  onWellClick: (well: string) => void;
  seriesIds: readonly QpcrMeltingSeriesId[];
}) {
  const { selectWell } = usePlateWellsActions();

  const openWell = useCallback(
    (well: string) => {
      selectWell(well);
      onWellClick(well);
    },
    [onWellClick, selectWell]
  );

  // Built per well rather than per render so the tiles' memo holds across a
  // dialog open/close; only a series or channel change rebuilds them.
  const linesByWell = useMemo(() => {
    const map = new Map<string, QpcrMeltingSparklineLine[]>();
    for (const well of channel.wells) {
      map.set(
        well.well,
        seriesIds.map((id) => ({
          meta: QPCR_MELTING_SERIES_META[id],
          geometry: sparklineGeometry(well.series[id] ?? []),
        }))
      );
    }
    return map;
  }, [channel.wells, seriesIds]);

  const renderTile = useCallback(
    (well: QpcrMeltingChannel["wells"][number]) => (
      <>
        <span className="px-1 pt-0.5 font-mono text-[10px] text-muted-foreground leading-none">
          {well.well}
        </span>
        <div className="min-h-0 flex-1 px-0.5 pb-0.5">
          <QpcrMeltingSparkline
            lines={linesByWell.get(well.well) ?? NO_LINES}
          />
        </div>
      </>
    ),
    [linesByWell]
  );

  return (
    <PlateGrid
      ariaLabel={`${channel.channel} plate`}
      onSelectWell={openWell}
      renderTile={renderTile}
      wells={channel.wells}
    />
  );
});
