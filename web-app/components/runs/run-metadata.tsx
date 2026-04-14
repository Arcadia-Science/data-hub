import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ");
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function RunMetadata({
  metadata,
}: {
  metadata: Record<string, unknown>;
}) {
  const entries = Object.entries(metadata);

  if (entries.length === 0) {
    return (
      <Card size="sm">
        <CardHeader>
          <CardTitle>Instrument Metadata</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No metadata recorded.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Instrument Metadata</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableBody>
            {entries.map(([key, value]) => (
              <TableRow key={key}>
                <TableCell className="w-[40%] align-top font-mono text-xs whitespace-nowrap text-muted-foreground">
                  {key}
                </TableCell>
                <TableCell className="min-w-0 align-top break-all whitespace-normal">
                  {formatValue(value)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
