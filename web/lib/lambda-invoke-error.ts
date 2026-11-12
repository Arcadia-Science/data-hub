// Error codes that Node's `fetch` raises while it is still connecting, before
// it has written any of the request. They come from the operating system
// (`ECONNREFUSED`, `ENOTFOUND`, ...), from undici's connect timeout, and from
// the TLS handshake. Any other failure, such as a reset socket, an abort, or a
// timeout while waiting for the response, can happen after the Lambda has
// received the request, so it says nothing about whether the Lambda is running.
const NOT_SENT_ERROR_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

// `fetch` wraps the real cause: a `TypeError: fetch failed` whose `cause` holds
// the error with the code. Follow the chain a few steps, with a limit in case a
// cause points back at an earlier error.
const MAX_CAUSE_DEPTH = 5;

// True only when `err` proves that the request never reached the Lambda. An
// error that does not say so counts as "may have been sent".
export function requestWasNotSent(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) {
      return false;
    }
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === "string" && NOT_SENT_ERROR_CODES.has(code)) {
      return true;
    }
    current = cause;
  }
  return false;
}
