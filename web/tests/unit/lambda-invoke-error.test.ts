import { describe, expect, it } from "vitest";
import { requestWasNotSent } from "@/lib/lambda-invoke-error";

// What Node's `fetch` throws: a `TypeError` with the real error as its cause.
function fetchFailed(code: string) {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error(code), { code }),
  });
}

describe("requestWasNotSent", () => {
  it.each([
    "ECONNREFUSED",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "UND_ERR_CONNECT_TIMEOUT",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  ])("is true when the connection failed with %s", (code) => {
    expect(requestWasNotSent(fetchFailed(code))).toBe(true);
  });

  it("is true when the code is on the error itself", () => {
    expect(
      requestWasNotSent(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))
    ).toBe(true);
  });

  it.each([
    "ECONNRESET",
    "EPIPE",
    "UND_ERR_SOCKET",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "ETIMEDOUT",
  ])("is false when the request may have gone out (%s)", (code) => {
    expect(requestWasNotSent(fetchFailed(code))).toBe(false);
  });

  it("is false for an abort or a timeout signal", () => {
    expect(
      requestWasNotSent(
        new DOMException("This operation was aborted", "AbortError")
      )
    ).toBe(false);
    expect(
      requestWasNotSent(
        new DOMException("The operation timed out", "TimeoutError")
      )
    ).toBe(false);
  });

  it("is false when the error does not say what happened", () => {
    expect(requestWasNotSent(new TypeError("fetch failed"))).toBe(false);
    expect(requestWasNotSent(new Error("boom"))).toBe(false);
    expect(requestWasNotSent("ECONNREFUSED")).toBe(false);
    expect(requestWasNotSent(null)).toBe(false);
    expect(requestWasNotSent(undefined)).toBe(false);
  });

  it("finds a code a few causes down, and stops on a cause that loops", () => {
    const inner = Object.assign(new Error("inner"), { code: "ENOTFOUND" });
    const wrapped = new Error("outer", {
      cause: new Error("middle", { cause: inner }),
    });
    expect(requestWasNotSent(wrapped)).toBe(true);

    const loop: { cause?: unknown } = {};
    loop.cause = loop;
    expect(requestWasNotSent(loop)).toBe(false);
  });
});
