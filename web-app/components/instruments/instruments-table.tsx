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
import { FlaskConical, SearchX } from "lucide-react";
import Link from "next/link";

const statusBadge: Record<
  InstrumentListItem["status"],
  { label: string; variant: "default" | "outline" | "secondary" }
> = {
  active: { label: "Active", variant: "default" },
  pending: { label: "Pending", variant: "outline" },
  inactive: { label: "Inactive", variant: "secondary" },
};

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
            <TableHead className="text-right">Watchers</TableHead>
            <TableHead className="text-right">Runs</TableHead>
            <TableHead className="w-[100px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((row) => {
            const sb = statusBadge[row.status];
            return (
              <TableRow key={row.id}>
                <TableCell>
                  <Link
                    href={`/instruments/${row.id}`}
                    className="flex items-center gap-1.5 hover:underline"
                  >
                    <FlaskConical className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="text-sm font-medium">
                      {row.displayName}
                    </span>
                  </Link>
                  <span className="mt-0.5 block font-mono text-[10px] text-muted-foreground">
                    {row.id}
                  </span>
                </TableCell>
                <TableCell>
                  <Badge variant={sb.variant} className="text-[10px]">
                    {sb.label}
                  </Badge>
                </TableCell>
                <TableCell>
                  {row.filePatterns && row.filePatterns.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {row.filePatterns.map((p) => (
                        <Badge
                          key={p}
                          variant="outline"
                          className="font-mono text-[10px] font-normal"
                        >
                          {p}
                        </Badge>
                      ))}
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-right font-mono text-sm">
                  {row.watcherCount}
                </TableCell>
                <TableCell className="text-right font-mono text-sm">
                  {row.runCount}
                </TableCell>
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
                      filePatterns={row.filePatterns ?? []}
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
