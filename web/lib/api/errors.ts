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
