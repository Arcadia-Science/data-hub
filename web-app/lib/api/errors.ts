export const VALIDATION_ERROR = "VALIDATION_ERROR";
export const NOT_FOUND = "NOT_FOUND";
export const CONFLICT = "CONFLICT";
export const UNAUTHORIZED = "UNAUTHORIZED";
export const INTERNAL_ERROR = "INTERNAL_ERROR";

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
