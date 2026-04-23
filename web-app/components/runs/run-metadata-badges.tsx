import { Badge } from "@/components/ui/badge";
import {
  CAPTURE_TYPE_COLORS,
  CHANNEL_COLOR_STYLES,
  IMAGING_MODE_COLORS,
  MEASUREMENT_MODE_COLORS,
  MEASUREMENT_TYPE_COLORS,
  buildWavelengthColorMap,
  getDyeChannelColor,
} from "@/lib/instrument-colors";
import { cn } from "@/lib/utils";

import {
  getMetadataArray,
  getMetadataField,
  getMetadataObjectArray,
  getMetadataRecord,
  sortWavelengths,
} from "@/components/runs/metadata-badges";

// ---------------------------------------------------------------------------
// Shared row component: label on the left, badge(s) on the right
// ---------------------------------------------------------------------------

function MetadataRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function ColorBadge({
  value,
  colorClass,
}: {
  value: string;
  colorClass?: string;
}) {
  return (
    <Badge variant="outline" className={cn("font-mono", colorClass)}>
      {value}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Plate reader
// ---------------------------------------------------------------------------

export function hasPlateReaderMetadata(metadata: Record<string, unknown>) {
  return Boolean(
    getMetadataArray(metadata, "wavelengths").length ||
    getMetadataField(metadata, "measurement_mode") ||
    getMetadataField(metadata, "measurement_type")
  );
}

export function PlateReaderRunBadges({
  metadata,
}: {
  metadata: Record<string, unknown>;
}) {
  const wavelengths = sortWavelengths(
    getMetadataArray(metadata, "wavelengths")
  );
  const mode = getMetadataField(metadata, "measurement_mode");
  const type = getMetadataField(metadata, "measurement_type");

  if (!wavelengths.length && !mode && !type) return null;

  const wavelengthColors = buildWavelengthColorMap(wavelengths);

  return (
    <>
      {type && (
        <MetadataRow label="Measurement Type">
          <ColorBadge value={type} colorClass={MEASUREMENT_TYPE_COLORS[type]} />
        </MetadataRow>
      )}
      {mode && (
        <MetadataRow label="Measurement Mode">
          <ColorBadge value={mode} colorClass={MEASUREMENT_MODE_COLORS[mode]} />
        </MetadataRow>
      )}
      {wavelengths.length > 0 && (
        <MetadataRow
          label={wavelengths.length === 1 ? "Wavelength" : "Wavelengths"}
        >
          {wavelengths.map((w) => (
            <ColorBadge key={w} value={w} colorClass={wavelengthColors[w]} />
          ))}
        </MetadataRow>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Gel doc
// ---------------------------------------------------------------------------

export function hasGelDocMetadata(metadata: Record<string, unknown>) {
  return Boolean(
    getMetadataField(metadata, "capture_type") ||
    getMetadataField(metadata, "imaging_mode") ||
    getMetadataArray(metadata, "wavelengths").length ||
    getMetadataArray(metadata, "colors").length
  );
}

export function GelDocRunBadges({
  metadata,
}: {
  metadata: Record<string, unknown>;
}) {
  const captureType = getMetadataField(metadata, "capture_type");
  const imagingMode = getMetadataField(metadata, "imaging_mode");
  const wavelengths = sortWavelengths(
    getMetadataArray(metadata, "wavelengths")
  );
  const colors = getMetadataArray(metadata, "colors");

  if (!captureType && !imagingMode && !wavelengths.length && !colors.length)
    return null;

  const wavelengthColors = buildWavelengthColorMap(wavelengths);

  return (
    <>
      {captureType && (
        <MetadataRow label="Capture Type">
          <ColorBadge
            value={captureType}
            colorClass={CAPTURE_TYPE_COLORS[captureType]}
          />
        </MetadataRow>
      )}
      {imagingMode && (
        <MetadataRow label="Imaging Mode">
          <ColorBadge
            value={imagingMode}
            colorClass={IMAGING_MODE_COLORS[imagingMode]}
          />
        </MetadataRow>
      )}
      {wavelengths.length > 0 && (
        <MetadataRow label="Wavelengths">
          {wavelengths.map((w) => (
            <ColorBadge key={w} value={w} colorClass={wavelengthColors[w]} />
          ))}
        </MetadataRow>
      )}
      {colors.length > 0 && (
        <MetadataRow label="Colors">
          {colors.map((c) => (
            <ColorBadge
              key={c}
              value={c}
              colorClass={CHANNEL_COLOR_STYLES[c]}
            />
          ))}
        </MetadataRow>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// qPCR
// ---------------------------------------------------------------------------

export function hasQpcrMetadata(metadata: Record<string, unknown>) {
  return getMetadataArray(metadata, "dye_channels").length > 0;
}

export function QpcrRunBadges({
  metadata,
}: {
  metadata: Record<string, unknown>;
}) {
  const dyeChannels = getMetadataArray(metadata, "dye_channels");

  if (dyeChannels.length === 0) return null;

  return (
    <MetadataRow label="Dye Channels">
      {dyeChannels.map((ch) => (
        <ColorBadge key={ch} value={ch} colorClass={getDyeChannelColor(ch)} />
      ))}
    </MetadataRow>
  );
}

// ---------------------------------------------------------------------------
// TapeStation
// ---------------------------------------------------------------------------

export function hasTapeStationMetadata(metadata: Record<string, unknown>) {
  return Boolean(getMetadataField(metadata, "Tape Type"));
}

export function TapeStationRunBadges({
  metadata,
}: {
  metadata: Record<string, unknown>;
}) {
  const tapeType = getMetadataField(metadata, "Tape Type");

  if (!tapeType) return null;

  return (
    <MetadataRow label="Tape Type">
      <ColorBadge value={tapeType} />
    </MetadataRow>
  );
}

// ---------------------------------------------------------------------------
// Hina microscope
// ---------------------------------------------------------------------------

export type HinaChannel = {
  name: string;
  color: string | null;
};

// Preferred dimension order for the `sizes` badge. ND2 files commonly include
// C (channels), Z (z-slices), T (time), Y (height), X (width); we render them
// in this order when present and append any unrecognised keys at the end so
// unknown dimensions still surface rather than being silently dropped.
const SIZE_DIMENSION_ORDER = ["T", "Z", "C", "Y", "X"];

export function extractHinaChannels(metadata: unknown): HinaChannel[] {
  const raw = getMetadataObjectArray(metadata, "channels");
  return raw
    .map((c) => {
      const name = c.name != null ? String(c.name) : "";
      const color = typeof c.color === "string" ? c.color : null;
      return { name, color };
    })
    .filter((c) => c.name.length > 0);
}

export function formatHinaSizes(sizes: Record<string, unknown>): string {
  const entries = Object.entries(sizes).filter(
    ([, v]) => typeof v === "number" || typeof v === "string"
  );
  if (entries.length === 0) return "";

  const known = SIZE_DIMENSION_ORDER.filter((k) =>
    entries.some(([ek]) => ek === k)
  );
  const unknown = entries
    .map(([k]) => k)
    .filter((k) => !SIZE_DIMENSION_ORDER.includes(k))
    .sort();
  const orderedKeys = [...known, ...unknown];

  const sizeMap = Object.fromEntries(entries) as Record<
    string,
    number | string
  >;

  // Separate spatial dimensions (Y x X) into a compact "HxW" group so the
  // badge reads like "C=4 · 256x256" rather than "C=4 · Y=256 · X=256".
  const spatial: string[] = [];
  if (sizeMap.Y != null) spatial.push(String(sizeMap.Y));
  if (sizeMap.X != null) spatial.push(String(sizeMap.X));

  const scalar = orderedKeys
    .filter((k) => k !== "X" && k !== "Y")
    .map((k) => `${k}=${sizeMap[k]}`);

  const parts = [...scalar];
  if (spatial.length > 0) parts.push(spatial.join("\u00d7"));
  return parts.join(" \u00b7 ");
}

export function hasHinaMetadata(metadata: Record<string, unknown>) {
  return Boolean(
    extractHinaChannels(metadata).length ||
    getMetadataArray(metadata, "dimensions").length ||
    (getMetadataRecord(metadata, "sizes") &&
      Object.keys(getMetadataRecord(metadata, "sizes") ?? {}).length > 0)
  );
}

// Inline-styled badge using an arbitrary hex color for the border + text.
// Used for Hina channels since channel color is run-specific and can't be
// baked into a static Tailwind palette.
function ChannelBadge({ name, color }: HinaChannel) {
  const style = color ? { borderColor: color, color } : undefined;
  return (
    <Badge variant="outline" className="font-mono" style={style}>
      {color && (
        <span
          aria-hidden="true"
          className="inline-block size-2 rounded-full"
          style={{ backgroundColor: color }}
        />
      )}
      {name}
    </Badge>
  );
}

export function HinaChannelBadges({ channels }: { channels: HinaChannel[] }) {
  if (channels.length === 0)
    return <span className="text-muted-foreground">&mdash;</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {channels.map((c) => (
        <ChannelBadge key={c.name} name={c.name} color={c.color} />
      ))}
    </div>
  );
}

export function HinaRunBadges({
  metadata,
}: {
  metadata: Record<string, unknown>;
}) {
  const channels = extractHinaChannels(metadata);
  const dimensions = getMetadataArray(metadata, "dimensions");
  const sizes = getMetadataRecord(metadata, "sizes");
  const sizesLabel = sizes ? formatHinaSizes(sizes) : "";

  if (channels.length === 0 && dimensions.length === 0 && !sizesLabel)
    return null;

  return (
    <>
      {channels.length > 0 && (
        <MetadataRow label={channels.length === 1 ? "Channel" : "Channels"}>
          {channels.map((c) => (
            <ChannelBadge key={c.name} name={c.name} color={c.color} />
          ))}
        </MetadataRow>
      )}
      {dimensions.length > 0 && (
        <MetadataRow label="Dimensions">
          {dimensions.map((d) => (
            <ColorBadge key={d} value={d} />
          ))}
        </MetadataRow>
      )}
      {sizesLabel && (
        <MetadataRow label="Sizes">
          <ColorBadge value={sizesLabel} />
        </MetadataRow>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Default / generic — each key gets a row with outline badge value(s)
// ---------------------------------------------------------------------------

function formatBadgeValue(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const strings = value.map(String).filter(Boolean);
    return strings.length > 0 ? strings : null;
  }
  if (typeof value === "object") return [JSON.stringify(value)];
  const s = String(value);
  return s ? [s] : null;
}

function formatLabel(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function hasDefaultMetadata(metadata: Record<string, unknown>) {
  return Object.values(metadata).some((v) => formatBadgeValue(v) !== null);
}

export function DefaultRunBadges({
  metadata,
}: {
  metadata: Record<string, unknown>;
}) {
  const rows = Object.entries(metadata)
    .map(([key, value]) => ({
      key,
      label: formatLabel(key),
      values: formatBadgeValue(value),
    }))
    .filter((r): r is typeof r & { values: string[] } => r.values !== null);

  if (rows.length === 0) return null;

  return (
    <>
      {rows.map(({ key, label, values }) => (
        <MetadataRow key={key} label={label}>
          {values.map((v, i) => (
            <ColorBadge key={`${v}-${i}`} value={v} />
          ))}
        </MetadataRow>
      ))}
    </>
  );
}
