import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function getMetadataField(
  metadata: unknown,
  key: string
): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>)[key];
  return value != null ? String(value) : null;
}

export function getMetadataArray(metadata: unknown, key: string): string[] {
  if (!metadata || typeof metadata !== "object") return [];
  const value = (metadata as Record<string, unknown>)[key];
  if (Array.isArray(value)) return value.map(String);
  if (value != null) return [String(value)];
  return [];
}

export function MetadataFieldBadge({
  value,
  colorClass,
}: {
  value: string | null;
  colorClass?: string;
}) {
  if (!value) return <span className="text-muted-foreground">&mdash;</span>;
  return (
    <Badge variant="outline" className={cn("font-mono", colorClass)}>
      {value}
    </Badge>
  );
}

export function MetadataArrayBadges({
  values,
  colorMap,
}: {
  values: string[];
  colorMap?: Record<string, string>;
}) {
  if (values.length === 0)
    return <span className="text-muted-foreground">&mdash;</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {values.map((v) => (
        <Badge
          key={v}
          variant="outline"
          className={cn("font-mono", colorMap?.[v])}
        >
          {v}
        </Badge>
      ))}
    </div>
  );
}
