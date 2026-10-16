/**
 * Decodes a dynamic route segment on a page. Pages receive the segment still
 * percent-encoded, while route handlers receive it decoded, so a page decodes
 * once here and passes the real value everywhere else. A `%` that is not part
 * of an escape stays as typed instead of throwing.
 */
export function decodePageParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
