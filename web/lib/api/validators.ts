import { RUN_STATUS_VALUES, type RunStatus } from "@/lib/runs/run-status";

const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RUN_STATUS_SET = new Set<string>(RUN_STATUS_VALUES);

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
  if (value === null) {
    return opts.default;
  }
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) {
    return opts.default;
  }
  let clamped = n;
  if (opts.min != null) {
    clamped = Math.max(opts.min, clamped);
  }
  if (opts.max != null) {
    clamped = Math.min(opts.max, clamped);
  }
  return clamped;
}

export function parseDateParam(value: string | null): Date | null {
  if (!value) {
    return null;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Accepts repeated (`?status=a&status=b`) or comma-separated (`?status=a,b`)
// values, silently dropping unknown ones. Returns undefined when nothing valid
// remains so the query treats it as "no status filter".
export function parseRunStatusParam(
  searchParams: URLSearchParams
): RunStatus[] | undefined {
  const seen = new Set<RunStatus>();
  for (const raw of searchParams.getAll("status")) {
    for (const part of raw.split(",")) {
      const value = part.trim();
      if (RUN_STATUS_SET.has(value)) {
        seen.add(value as RunStatus);
      }
    }
  }
  return seen.size > 0 ? [...seen] : undefined;
}
