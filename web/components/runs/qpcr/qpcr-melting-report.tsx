import { Download } from "lucide-react";
import { QpcrMeltingPlateGrid } from "@/components/runs/qpcr/qpcr-melting-plate-grid";
import { ReportDataShell } from "@/components/runs/report-data-shell";
import type { QpcrMeltingPlateData } from "@/lib/runs/qpcr-melting";

export function QpcrMeltingReport({
  derivativesCsvFileId,
  plate,
}: QpcrMeltingPlateData) {
  const channels = plate.channels.filter((channel) => channel.wells.length > 0);
  const wellCount = channels.reduce(
    (sum, channel) => sum + channel.wells.length,
    0
  );

  return (
    <ReportDataShell showCount={false} title="Report Data" total={wellCount}>
      <div className="flex flex-col gap-10">
        {derivativesCsvFileId != null && (
          <a
            className="inline-flex items-center gap-1.5 self-end text-muted-foreground text-sm hover:text-foreground"
            download
            href={`/api/v1/files/${derivativesCsvFileId}/download`}
          >
            <Download aria-hidden className="size-3.5" />
            Download derivatives CSV
          </a>
        )}
        {channels.map((channel) => (
          <div className="flex min-w-0 flex-col gap-3" key={channel.channel}>
            <h3 className="min-w-0 text-pretty font-medium font-mono text-foreground text-sm leading-snug">
              {channel.channel}
            </h3>
            <QpcrMeltingPlateGrid channel={channel} />
          </div>
        ))}
      </div>
    </ReportDataShell>
  );
}
