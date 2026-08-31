"use client";

import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import { PlateWellsProvider } from "@/components/runs/plate-wells-provider";
import { QpcrMeltingPlateGrid } from "@/components/runs/qpcr/qpcr-melting-plate-grid";
import { QpcrMeltingSeriesToggle } from "@/components/runs/qpcr/qpcr-melting-series-toggle";
import { ReportDataShell } from "@/components/runs/report-data-shell";
import {
  QPCR_MELTING_PRIMARY_SERIES,
  type QpcrMeltingChannel,
  type QpcrMeltingPlateData,
  type QpcrMeltingSeriesId,
} from "@/lib/runs/qpcr-melting";

// The dialog pulls in Recharts and the CSV parser, which nothing on the page
// needs until a well is opened, so they load as a separate chunk.
const QpcrMeltingWellDialog = lazy(() =>
  import("@/components/runs/qpcr/qpcr-melting-well-dialog").then((mod) => ({
    default: mod.QpcrMeltingWellDialog,
  }))
);

export function QpcrMeltingReport({
  derivativesCsvFileId,
  plate,
}: QpcrMeltingPlateData) {
  const channels = useMemo(
    () => plate.channels.filter((channel) => channel.wells.length > 0),
    [plate.channels]
  );
  const wellCount = channels.reduce(
    (sum, channel) => sum + channel.wells.length,
    0
  );

  return (
    <ReportDataShell showCount={false} title="Melting Curves" total={wellCount}>
      <div className="flex flex-col gap-10">
        {channels.map((channel) => (
          <QpcrMeltingChannelSection
            channel={channel}
            derivativesCsvFileId={derivativesCsvFileId}
            key={channel.channel}
          />
        ))}
      </div>
    </ReportDataShell>
  );
}

function QpcrMeltingChannelSection({
  channel,
  derivativesCsvFileId,
}: {
  channel: QpcrMeltingChannel;
  derivativesCsvFileId: number | null;
}) {
  const [seriesId, setSeriesId] = useState<QpcrMeltingSeriesId>(
    QPCR_MELTING_PRIMARY_SERIES
  );
  const [open, setOpen] = useState(false);
  const openDialog = useCallback(() => setOpen(true), []);
  const wellLabels = useMemo(
    () => channel.wells.map((well) => well.well),
    [channel.wells]
  );

  return (
    <PlateWellsProvider wells={wellLabels}>
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <h3 className="min-w-0 text-pretty font-medium font-mono text-foreground text-sm leading-snug">
            {channel.channel}
          </h3>
          <QpcrMeltingSeriesToggle onChange={setSeriesId} value={seriesId} />
        </div>
        <QpcrMeltingPlateGrid
          channel={channel}
          onWellClick={openDialog}
          seriesId={seriesId}
        />
        <Suspense fallback={null}>
          <QpcrMeltingWellDialog
            channel={channel}
            derivativesCsvFileId={derivativesCsvFileId}
            onOpenChange={setOpen}
            onSeriesChange={setSeriesId}
            open={open}
            seriesId={seriesId}
          />
        </Suspense>
      </div>
    </PlateWellsProvider>
  );
}
