import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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

export function getMetadataRecord(
  metadata: unknown,
  key: string
): Record<string, unknown> | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>)[key];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function getMetadataObjectArray(
  metadata: unknown,
  key: string
): Record<string, unknown>[] {
  if (!metadata || typeof metadata !== "object") return [];
  const value = (metadata as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is Record<string, unknown> =>
      v !== null && typeof v === "object" && !Array.isArray(v)
  );
}

/**
 * Sort a list of wavelength strings (e.g. `"750"`) in ascending numerical
 * order. Non-numeric entries are pushed to the end, preserving their
 * relative order, so mixed inputs still render predictably.
 */
export function sortWavelengths(wavelengths: string[]): string[] {
  return [...wavelengths].sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    const aNum = Number.isFinite(na);
    const bNum = Number.isFinite(nb);
    if (aNum && bNum) return na - nb;
    if (aNum) return -1;
    if (bNum) return 1;
    return a.localeCompare(b);
  });
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

function BadgeRow({
  values,
  colorMap,
  className,
}: {
  values: string[];
  colorMap?: Record<string, string>;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap gap-1", className)}>
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

export function MetadataArrayBadges({
  values,
  colorMap,
}: {
  values: string[];
  colorMap?: Record<string, string>;
}) {
  if (values.length === 0)
    return <span className="text-muted-foreground">&mdash;</span>;
  return <BadgeRow values={values} colorMap={colorMap} />;
}

/**
 * Renders up to `maxVisible` badges followed by a `+N` overflow badge when
 * the array exceeds the limit. Hovering the cell surfaces a tooltip listing
 * every badge on a single row (no wrapping) so the collapsed values remain
 * discoverable. When the array fits within `maxVisible` no tooltip is shown.
 */
export function TruncatedBadges({
  values,
  colorMap,
  maxVisible = 2,
}: {
  values: string[];
  colorMap?: Record<string, string>;
  maxVisible?: number;
}) {
  if (values.length === 0)
    return <span className="text-muted-foreground">&mdash;</span>;

  if (values.length <= maxVisible) {
    return <BadgeRow values={values} colorMap={colorMap} />;
  }

  const visible = values.slice(0, maxVisible);
  const hiddenCount = values.length - maxVisible;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex flex-wrap gap-1">
          {visible.map((v) => (
            <Badge
              key={v}
              variant="outline"
              className={cn("font-mono", colorMap?.[v])}
            >
              {v}
            </Badge>
          ))}
          <Badge
            variant="outline"
            className="font-mono text-muted-foreground"
            aria-label={`${hiddenCount} more`}
          >
            +{hiddenCount}
          </Badge>
        </div>
      </TooltipTrigger>
      <TooltipContent className="max-w-none">
        <BadgeRow values={values} colorMap={colorMap} className="flex-nowrap" />
      </TooltipContent>
    </Tooltip>
  );
}
