// The SQLSTATE that Postgres raises when `lock_timeout` runs out.
export const LOCK_NOT_AVAILABLE = "55P03";

// The SQLSTATE for a unique index or constraint that a write would break.
export const UNIQUE_VIOLATION = "23505";

// `pg` puts the SQLSTATE on `code`. Drizzle wraps the `pg` error as the
// `cause` of its own, so look down the chain.
export function hasPgErrorCode(err: unknown, code: string): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== "object" || current === null) {
      return false;
    }
    const { code: found, cause } = current as {
      code?: unknown;
      cause?: unknown;
    };
    if (found === code) {
      return true;
    }
    current = cause;
  }
  return false;
}
