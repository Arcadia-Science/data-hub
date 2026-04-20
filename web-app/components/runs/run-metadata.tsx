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
      <div className="flex items-center rounded-lg border px-4 py-3">
        <div>
          <p className="text-sm font-semibold">Instrument metadata</p>
          <p className="text-xs text-muted-foreground">
            No metadata recorded yet
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border">
      <div className="px-4 py-3">
        <p className="text-sm font-semibold">Instrument metadata</p>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-1 border-t px-4 py-3">
        {entries.map(([key, value]) => (
          <span key={key} className="text-xs text-muted-foreground">
            <span className="font-mono">{key}</span>:{" "}
            <span className="text-foreground">{formatValue(value)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
