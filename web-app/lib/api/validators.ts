const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidKebabCase(id: string): boolean {
  return KEBAB_RE.test(id);
}

export function isValidUUID(id: string): boolean {
  return UUID_RE.test(id);
}

export function parseIntParam(
  value: string | null,
  opts: { default: number; min?: number; max?: number }
): number {
  if (value === null) return opts.default;
  const n = parseInt(value, 10);
  if (isNaN(n)) return opts.default;
  let clamped = n;
  if (opts.min != null) clamped = Math.max(opts.min, clamped);
  if (opts.max != null) clamped = Math.min(opts.max, clamped);
  return clamped;
}

export function parseDateParam(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}
