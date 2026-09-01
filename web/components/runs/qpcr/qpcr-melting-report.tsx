"use client";

import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import { PlateWellsProvider } from "@/components/runs/plate-wells-provider";
import { QpcrMeltingPlateGrid } from "@/components/runs/qpcr/qpcr-melting-plate-grid";
import { QpcrMeltingSeriesToggle } from "@/components/runs/qpcr/qpcr-melting-series-toggle";
import {
  ReportDataEmpty,
  ReportDataShell,
} from "@/components/runs/report-data-shell";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  QPCR_MELTING_PLATE_SERIES,
  QPCR_MELTING_WELL_SERIES,
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
  if (channels.length === 0) {
    return <ReportDataEmpty title="Melting Curves" />;
  }

  // No count in the heading: the card shows one channel at a time, so a total
  // across all four would not describe what is on screen.
  return (
    <ReportDataShell title="Melting Curves">
      <QpcrMeltingPlateView
        channels={channels}
        derivativesCsvFileId={derivativesCsvFileId}
      />
    </ReportDataShell>
  );
}

// One channel on screen at a time. Four stacked 96-well grids made the card
// several screens tall, and the channels are the same plate read through
// different dyes, so they are compared one at a time rather than side by side.
function QpcrMeltingPlateView({
  channels,
  derivativesCsvFileId,
}: {
  channels: QpcrMeltingChannel[];
  derivativesCsvFileId: number | null;
}) {
  const [channelName, setChannelName] = useState(channels[0].channel);
  // The plate and the single-well chart keep separate selections. They start
  // from different defaults, and what makes a 96-tile plate readable is not
  // what makes one well informative.
  const [plateSeriesIds, setPlateSeriesIds] = useState<
    readonly QpcrMeltingSeriesId[]
  >(QPCR_MELTING_PLATE_SERIES);
  const [wellSeriesIds, setWellSeriesIds] = useState<
    readonly QpcrMeltingSeriesId[]
  >(QPCR_MELTING_WELL_SERIES);
  const [open, setOpen] = useState(false);
  const openDialog = useCallback(() => setOpen(true), []);

  const channel =
    channels.find((c) => c.channel === channelName) ?? channels[0];
  // Wells are keyed by label, so holding the selection across a channel
  // change keeps the seeker and the dialog on the same well.
  const wellLabels = useMemo(
    () => channel.wells.map((well) => well.well),
    [channel.wells]
  );

  return (
    <PlateWellsProvider wells={wellLabels}>
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <ChannelPicker
            channels={channels}
            onChange={setChannelName}
            value={channel.channel}
          />
          <QpcrMeltingSeriesToggle
            onChange={setPlateSeriesIds}
            value={plateSeriesIds}
          />
        </div>
        <QpcrMeltingPlateGrid
          channel={channel}
          onWellClick={openDialog}
          seriesIds={plateSeriesIds}
        />
        <Suspense fallback={null}>
          <QpcrMeltingWellDialog
            channel={channel}
            derivativesCsvFileId={derivativesCsvFileId}
            onOpenChange={setOpen}
            onSeriesChange={setWellSeriesIds}
            open={open}
            seriesIds={wellSeriesIds}
          />
        </Suspense>
      </div>
    </PlateWellsProvider>
  );
}

function ChannelPicker({
  channels,
  onChange,
  value,
}: {
  channels: QpcrMeltingChannel[];
  onChange: (next: string) => void;
  value: string;
}) {
  // A single-channel run still needs its name on screen, and a one-option
  // dropdown would be a control that does nothing.
  if (channels.length <= 1) {
    return (
      <h3 className="min-w-0 text-pretty font-medium font-mono text-foreground text-sm leading-snug">
        {value}
      </h3>
    );
  }

  return (
    <Select onValueChange={onChange} value={value}>
      <SelectTrigger aria-label="Channel" className="font-mono" size="sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {channels.map((channel) => (
          <SelectItem
            className="font-mono"
            key={channel.channel}
            value={channel.channel}
          >
            {channel.channel}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
