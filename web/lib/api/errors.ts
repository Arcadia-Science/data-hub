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
// Paired with HTTP 413. A watcher that cannot split an upload would send
// the whole file in one request, which S3 rejects above 5 GiB.
export const PAYLOAD_TOO_LARGE = "PAYLOAD_TOO_LARGE";
// `details.reason` on the 409 that refuses a request because its run was
// deleted. The message is for people; a client reads the reason to tell this
// conflict from others.
export const RUN_DELETED_REASON = "run_deleted";
// Paired with HTTP 404. Returned by the heartbeat route and `GET /watchers/{id}`
// when the watcher's row exists but was deregistered (soft-deleted). The
// heartbeat route sends it only to a caller that may act for the watcher (see
// `callerMayActForWatcher`); `GET /watchers/{id}` sends it to every caller with
// `watchers:read`, who can already see a deregistered watcher in the list. A row
// that does not exist keeps `NOT_FOUND`, so a watcher stops for good only when
// its registration was deleted on purpose, not when rows went missing from the
// database. The watcher CLI stops on this string: keep it equal to
// `WATCHER_DEREGISTERED_ERROR_CODE` in `watcher/src/data_hub_watcher/constants.py`.
export const WATCHER_DEREGISTERED = "WATCHER_DEREGISTERED";
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

// 409 for a request a deleted run can't take: `{ error: { code: "CONFLICT",
// message, details: { reason: "run_deleted" } } }`.
export function runDeletedError(message: string) {
  return apiError(409, CONFLICT, message, { reason: RUN_DELETED_REASON });
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
