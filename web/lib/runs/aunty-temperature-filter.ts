// Temperature filter values are `start|end` so the URL stays a single token.
// `|` cannot appear in the jsonb `->>` numeric strings we store.
const AUNTY_TEMPERATURE_SEPARATOR = "|";

export function encodeAuntyTemperatureFilter(
  start: string,
  end: string
): string {
  return `${start}${AUNTY_TEMPERATURE_SEPARATOR}${end}`;
}

export function decodeAuntyTemperatureFilter(
  value: string
):
  | { end: string; kind: "range"; start: string }
  | { kind: "hold"; value: string }
  | null {
  if (!value.includes(AUNTY_TEMPERATURE_SEPARATOR)) {
    return value ? { kind: "hold", value } : null;
  }
  const separator = value.indexOf(AUNTY_TEMPERATURE_SEPARATOR);
  if (
    separator <= 0 ||
    separator !== value.lastIndexOf(AUNTY_TEMPERATURE_SEPARATOR)
  ) {
    return null;
  }
  const start = value.slice(0, separator);
  const end = value.slice(separator + 1);
  if (!(start && end)) {
    return null;
  }
  return { kind: "range", start, end };
}
