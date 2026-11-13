// The request header that `proxy.ts` fills with the path exactly as it was
// sent, still percent-encoded.
export const RAW_PATH_HEADER = "x-data-hub-raw-path";

// The API path, or the run page path, up to and including the run ID.
const RUN_ID_IN_PATH = /^(?:\/api\/v1)?\/instruments\/[^/]+\/runs\/([^/]+)/;

// Decodes once, and returns the input when it has a malformed escape. This is
// what Next.js does to a route parameter the second time on Vercel (see
// `decodeQueryPathParameter` in the Next.js server).
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

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
 * ID from that header and decodes it once. It trusts that value only when it
 * agrees with `paramValue`: it is the same, or it is what a second decoding
 * turns into `paramValue`. Otherwise the header doesn't belong to this route,
 * for example when a client planted it, and `paramValue` wins.
 *
 * `paramValue` is the fallback that the caller passes in. A route handler
 * passes its route parameter. The run page passes its parameter decoded with
 * `decodePageParam`, because a page gets the parameter still encoded. It is
 * returned when the header is missing, doesn't name a run, has a malformed
 * escape, or disagrees.
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
  let runId: string;
  try {
    runId = decodeURIComponent(segment);
  } catch {
    return paramValue;
  }
  return runId === paramValue || safeDecode(runId) === paramValue
    ? runId
    : paramValue;
}
