export const VALIDATION_ERROR = "VALIDATION_ERROR";
export const NOT_FOUND = "NOT_FOUND";
export const CONFLICT = "CONFLICT";
export const UNAUTHORIZED = "UNAUTHORIZED";
export const FORBIDDEN = "FORBIDDEN";
export const INTERNAL_ERROR = "INTERNAL_ERROR";
// Paired with HTTP 426. Returned by the heartbeat route when the
// watcher's reported version is below the configured
// `watcher_release_config.min_supported_version` floor.
export const UPGRADE_REQUIRED = "UPGRADE_REQUIRED";
// Paired with HTTP 409. Returned by the upload-request routes when the
// instrument has no online watcher to pick up the queue — without one,
// queued files would sit in `upload_requested` forever (never reaching S3).
export const WATCHER_OFFLINE = "WATCHER_OFFLINE";

export function apiError(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>
) {
  return Response.json(
    { error: { code, message, ...(details && { details }) } },
    { status }
  );
}

// Shared helpers return `{ ok: false, status, code, message }`; map them to
// the wire error shape without per-route switch statements. `code` values
// already match the constants above (`NOT_FOUND`, `WATCHER_OFFLINE`, …).
export function apiErrorFromResult(result: {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}): Response {
  return apiError(result.status, result.code, result.message, result.details);
}
