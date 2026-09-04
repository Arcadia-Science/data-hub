import type { ComponentProps } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type BadgeVariant = ComponentProps<typeof Badge>["variant"];

export function getMetadataField(
  metadata: unknown,
  key: string
): string | null {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }
  const value = (metadata as Record<string, unknown>)[key];
  return value == null ? null : String(value);
}

export function getMetadataArray(metadata: unknown, key: string): string[] {
  if (!metadata || typeof metadata !== "object") {
    return [];
  }
  const value = (metadata as Record<string, unknown>)[key];
  if (Array.isArray(value)) {
    return value.map(String);
  }
  if (value != null) {
    return [String(value)];
  }
  return [];
}

export function getMetadataRecord(
  metadata: unknown,
  key: string
): Record<string, unknown> | null {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }
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
  if (!metadata || typeof metadata !== "object") {
    return [];
  }
  const value = (metadata as Record<string, unknown>)[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (v): v is Record<string, unknown> =>
      v !== null && typeof v === "object" && !Array.isArray(v)
  );
}

/**
 * Sort a list of wavelength strings (e.g. `"750"` or `"440–450"`) in
 * ascending numerical order. Range tokens sort by their start. Other
 * non-numeric entries are pushed to the end, preserving their relative
 * order, so mixed inputs still render predictably.
 */
export function sortWavelengths(wavelengths: string[]): string[] {
  return [...wavelengths].sort((a, b) => {
    const ka = wavelengthSortKey(a);
    const kb = wavelengthSortKey(b);
    if (ka !== null && kb !== null) {
      return ka - kb;
    }
    if (ka !== null) {
      return -1;
    }
    if (kb !== null) {
      return 1;
    }
    return a.localeCompare(b);
  });
}

const WAVELENGTH_RANGE_RE = /^(\d+(?:\.\d+)?)[–-](\d+(?:\.\d+)?)$/;

function wavelengthSortKey(value: string): number | null {
  const n = Number(value);
  if (Number.isFinite(n)) {
    return n;
  }
  const range = WAVELENGTH_RANGE_RE.exec(value);
  if (range) {
    return Number(range[1]);
  }
  return null;
}

export function MetadataFieldBadge({
  value,
  colorClass,
}: {
  value: string | null;
  colorClass?: string;
}) {
  if (!value) {
    return <span className="text-muted-foreground">&mdash;</span>;
  }
  return <Badge className={cn("font-mono", colorClass)}>{value}</Badge>;
}

function BadgeRow({
  values,
  colorMap,
  className,
  badgeClassName,
  variant,
}: {
  values: string[];
  colorMap?: Record<string, string>;
  className?: string;
  badgeClassName?: string;
  variant?: BadgeVariant;
}) {
  return (
    <div className={cn("flex flex-wrap gap-1", className)}>
      {values.map((v) => (
        <Badge
          className={cn("font-mono", badgeClassName, colorMap?.[v])}
          key={v}
          variant={variant}
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
  if (values.length === 0) {
    return <span className="text-muted-foreground">&mdash;</span>;
  }
  return <BadgeRow colorMap={colorMap} values={values} />;
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
  badgeClassName,
  variant,
}: {
  values: string[];
  colorMap?: Record<string, string>;
  maxVisible?: number;
  badgeClassName?: string;
  variant?: BadgeVariant;
}) {
  if (values.length === 0) {
    return <span className="text-muted-foreground">&mdash;</span>;
  }

  if (values.length <= maxVisible) {
    return (
      <BadgeRow
        badgeClassName={badgeClassName}
        colorMap={colorMap}
        values={values}
        variant={variant}
      />
    );
  }

  const visible = values.slice(0, maxVisible);
  const hiddenCount = values.length - maxVisible;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex flex-wrap gap-1">
          {visible.map((v) => (
            <Badge
              className={cn("font-mono", badgeClassName, colorMap?.[v])}
              key={v}
              variant={variant}
            >
              {v}
            </Badge>
          ))}
          <Badge
            aria-label={`${hiddenCount} more`}
            className="font-mono text-muted-foreground"
            variant="outline"
          >
            +{hiddenCount}
          </Badge>
        </div>
      </TooltipTrigger>
      <TooltipContent className="max-w-none">
        <BadgeRow
          badgeClassName={badgeClassName}
          className="flex-nowrap"
          colorMap={colorMap}
          values={values}
          variant={variant}
        />
      </TooltipContent>
    </Tooltip>
  );
}
