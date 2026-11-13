// The request header that `proxy.ts` fills with the path exactly as it was
// sent, still percent-encoded.
export const RAW_PATH_HEADER = "x-data-hub-raw-path";

// The API path, or the run page path, up to and including the run ID.
const RUN_ID_IN_PATH = /^(?:\/api\/v1)?\/instruments\/[^/]+\/runs\/([^/]+)/;

/**
 * Returns the run ID of a request, exactly as the client sent it.
 *
 * On Vercel, Next.js decodes a dynamic route parameter twice (ENG-2166). It
 * decodes it once to match the route, and again because the handler isn't
 * wrapped by the Next.js server there. A run ID of `Q%41`, sent as `Q%2541`,
 * reaches the handler as `QA`, and `50%2525` reaches it as `50%`. With
 * `next start` the parameter is decoded once, so local runs and tests can't
 * show this.
 *
 * `proxy.ts` copies the path as sent into a request header. This reads the run
 * ID from that header and decodes it once. It returns `paramValue`, the
 * fallback that the caller passes in, when the header is missing, doesn't name
 * a run, or has a malformed escape.
 */
export function readRunIdParam(
  headers: Pick<Headers, "get">,
  paramValue: string
): string {
  const rawPath = headers.get(RAW_PATH_HEADER);
  const segment = rawPath ? RUN_ID_IN_PATH.exec(rawPath)?.[1] : undefined;
  if (segment === undefined) {
    return paramValue;
  }
  try {
    return decodeURIComponent(segment);
  } catch {
    return paramValue;
  }
}
