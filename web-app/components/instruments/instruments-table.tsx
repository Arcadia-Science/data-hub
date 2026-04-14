import { EditInstrumentDialog } from "@/components/instruments/edit-instrument-dialog";
import { StatusActions } from "@/components/instruments/status-actions";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { InstrumentListItem } from "@/lib/api/instruments";
import { formatDistanceToNowStrict, isToday } from "date-fns";
import { FlaskConical, Radio, SearchX, WifiOff } from "lucide-react";
import Link from "next/link";

function formatLastRun(date: Date | null): string {
  if (!date) return "—";
  if (isToday(date)) return "Today";
  return formatDistanceToNowStrict(date, { addSuffix: true });
}

export function InstrumentsTable({ data }: { data: InstrumentListItem[] }) {
  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-16">
        <SearchX className="size-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          No instruments configured yet.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Instrument</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>File Patterns</TableHead>
            <TableHead>Total Runs</TableHead>
            <TableHead>Last Run</TableHead>
            <TableHead className="w-[100px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((row) => {
            const isOnline = row.watcherCount > 0 && row.watchersOnline > 0;
            return (
              <TableRow key={row.id} className="text-sm">
                <TableCell>
                  <Link
                    href={`/instruments/${row.id}`}
                    className="flex items-center gap-1.5 hover:underline"
                  >
                    <FlaskConical className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="font-medium">{row.displayName}</span>
                  </Link>
                  <span className="mt-0.5 block font-mono text-xs text-muted-foreground">
                    {row.id}
                  </span>
                </TableCell>
                <TableCell>
                  {row.watcherCount > 0 ? (
                    <Badge
                      variant={isOnline ? "default" : "destructive"}
                      className="gap-1 text-sm"
                    >
                      {isOnline ? (
                        <Radio className="size-3" />
                      ) : (
                        <WifiOff className="size-3" />
                      )}
                      {isOnline ? "Online" : "Offline"}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="gap-1 text-sm">
                      <WifiOff className="size-3" />
                      No Watcher
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  {row.filePatterns.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {row.filePatterns.map((p) => (
                        <Badge
                          key={p}
                          variant="outline"
                          className="font-mono text-sm font-normal"
                        >
                          {p}
                        </Badge>
                      ))}
                    </div>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="font-mono">{row.runCount}</TableCell>
                <TableCell>{formatLastRun(row.lastRunAt)}</TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1">
                    {/* Only pending instruments need the approval action;
                        active/inactive instruments are already confirmed. */}
                    {row.status === "pending" && (
                      <StatusActions instrumentId={row.id} />
                    )}
                    <EditInstrumentDialog
                      instrumentId={row.id}
                      displayName={row.displayName}
                      instrumentType={row.instrumentType}
                    />
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
