import { describe, expect, it } from "vitest";
import { RAW_PATH_HEADER, readRunIdParam } from "@/lib/api/run-id-param";
import { decodePageParam } from "@/lib/runs/page-param";

function headersWith(rawPath: string | null): Headers {
  const headers = new Headers();
  if (rawPath !== null) {
    headers.set(RAW_PATH_HEADER, rawPath);
  }
  return headers;
}

function apiPath(encodedRunId: string, rest = "request-upload-url") {
  return `/api/v1/instruments/x/runs/${encodedRunId}/${rest}`;
}

function pagePath(encodedRunId: string) {
  return `/instruments/x/runs/${encodedRunId}`;
}

// What Next.js passed as `params.runId` on a Vercel preview, for each run ID
// segment that was sent. A page gets the parameter still encoded. `page` is
// null for a segment that was only tried on a route handler.
const VERCEL_PROBE: {
  sent: string;
  route: string;
  page: string | null;
  runId: string;
}[] = [
  { sent: "Q%2541", route: "QA", page: "QA", runId: "Q%41" },
  { sent: "50%2525", route: "50%", page: "50%25", runId: "50%25" },
  { sent: "a%252541", route: "a%41", page: "a%2541", runId: "a%2541" },
  { sent: "100%2599", route: "100%99", page: null, runId: "100%99" },
  { sent: "a%23b%3Fc", route: "a#b?c", page: "a%23b%3Fc", runId: "a#b?c" },
  { sent: "a%2Fb", route: "a/b", page: "a%2Fb", runId: "a/b" },
  { sent: "a%20b", route: "a b", page: "a%20b", runId: "a b" },
  { sent: "caf%C3%A9", route: "café", page: "caf%C3%A9", runId: "café" },
  { sent: "x%2B1", route: "x+1", page: null, runId: "x+1" },
  { sent: "plain-id_1", route: "plain-id_1", page: null, runId: "plain-id_1" },
];

describe("readRunIdParam", () => {
  describe("on Vercel, where Next.js decodes the parameter twice", () => {
    it("restores an ID with a percent-escape in it", () => {
      // `Q%41` is sent as `Q%2541`. The handler is given `QA`.
      expect(readRunIdParam(headersWith(apiPath("Q%2541")), "QA")).toBe("Q%41");
    });

    it("restores an ID that ends in an encoded percent sign", () => {
      // `50%25` is sent as `50%2525`. The handler is given `50%`.
      expect(readRunIdParam(headersWith(apiPath("50%2525")), "50%")).toBe(
        "50%25"
      );
    });

    it("restores an ID with an escape inside an escape", () => {
      expect(readRunIdParam(headersWith(apiPath("a%252541")), "a%41")).toBe(
        "a%2541"
      );
    });

    it.each(VERCEL_PROBE)("gives a route handler $runId for $sent", ({
      sent,
      route,
      runId,
    }) => {
      expect(readRunIdParam(headersWith(apiPath(sent)), route)).toBe(runId);
    });

    // The run page passes its parameter through `decodePageParam` first.
    it.each(
      VERCEL_PROBE.filter((row) => row.page !== null)
    )("gives the run page $runId for $sent", ({ sent, page, runId }) => {
      const fallback = decodePageParam(page ?? "");
      expect(readRunIdParam(headersWith(pagePath(sent)), fallback)).toBe(runId);
    });
  });

  describe("under next start, where the parameter is decoded once", () => {
    it.each(VERCEL_PROBE)("gives a route handler $runId for $sent", ({
      sent,
      runId,
    }) => {
      const route = decodeURIComponent(sent);
      expect(readRunIdParam(headersWith(apiPath(sent)), route)).toBe(runId);
    });

    // A page gets the parameter still encoded.
    it.each(VERCEL_PROBE)("gives the run page $runId for $sent", ({
      sent,
      runId,
    }) => {
      const fallback = decodePageParam(sent);
      expect(readRunIdParam(headersWith(pagePath(sent)), fallback)).toBe(runId);
    });
  });

  describe("characters that Next.js hands over intact", () => {
    it.each([
      ["a#b", "a%23b"],
      ["what?", "what%3F"],
      ["two words", "two%20words"],
      ["a/b", "a%2Fb"],
      ["100% pure", "100%25%20pure"],
      ["plus+sign", "plus%2Bsign"],
      ["café", "caf%C3%A9"],
      ["研究 1", "%E7%A0%94%E7%A9%B6%201"],
      ["emoji \u{1f9ec}", "emoji%20%F0%9F%A7%AC"],
      ["plain-id_2026.03", "plain-id_2026.03"],
    ])("reads %j from %s", (runId, encoded) => {
      expect(readRunIdParam(headersWith(apiPath(encoded)), runId)).toBe(runId);
    });

    it("keeps an encoded slash inside the ID", () => {
      expect(readRunIdParam(headersWith(apiPath("a%2Fb%2Fc")), "a/b/c")).toBe(
        "a/b/c"
      );
    });
  });

  describe("paths that name a run", () => {
    it.each([
      ["a run", "/api/v1/instruments/x/runs/Q%2541"],
      ["a run's files", "/api/v1/instruments/x/runs/Q%2541/files"],
      [
        "a comment",
        "/api/v1/instruments/x/runs/Q%2541/comments/9f2c0f3e-0000-4000-8000-000000000000",
      ],
      ["the attribution", "/api/v1/instruments/x/runs/Q%2541/attributions/me"],
      ["the run page", "/instruments/x/runs/Q%2541"],
    ])("finds the ID in the path of %s", (_name, rawPath) => {
      expect(readRunIdParam(headersWith(rawPath), "QA")).toBe("Q%41");
    });

    it("does not read the instrument as the run", () => {
      expect(
        readRunIdParam(
          headersWith("/api/v1/instruments/Q%2541/runs/real-run"),
          "real-run"
        )
      ).toBe("real-run");
    });
  });

  describe("a header that doesn't agree with the parameter", () => {
    it("returns the parameter when the header names another run", () => {
      // A client planted the header, or the proxy saw another path.
      expect(
        readRunIdParam(headersWith(apiPath("other-run", "restore")), "my-run")
      ).toBe("my-run");
    });

    it("returns the parameter when the header names another run with an escape", () => {
      expect(readRunIdParam(headersWith(apiPath("Q%2541")), "Q")).toBe("Q");
      expect(readRunIdParam(headersWith(apiPath("Q%2541")), "QB")).toBe("QB");
    });

    it("returns the parameter when the header only agrees after three decodings", () => {
      // `a%25252541` decodes to `a%252541`, then `a%2541`, then `a%41`.
      expect(readRunIdParam(headersWith(apiPath("a%25252541")), "a%41")).toBe(
        "a%41"
      );
    });

    it("returns the parameter when the run page's fallback is another run", () => {
      expect(readRunIdParam(headersWith(pagePath("other-run")), "my-run")).toBe(
        "my-run"
      );
    });

    it("returns the parameter when the header names the run with other case", () => {
      expect(readRunIdParam(headersWith(apiPath("RUN-1")), "run-1")).toBe(
        "run-1"
      );
    });
  });

  describe("when the header can't be used", () => {
    it("returns the parameter when the header is missing", () => {
      expect(readRunIdParam(headersWith(null), "Q%41")).toBe("Q%41");
    });

    it("returns the parameter when the header is empty", () => {
      expect(readRunIdParam(headersWith(""), "run-1")).toBe("run-1");
    });

    it.each([
      "/api/v1/instruments/x/runs",
      "/api/v1/instruments/x/runs/",
      "/api/v1/instruments/x",
      "/api/v1/files/12/reprocess",
      "/api/v1/instruments/x/files/Q%2541",
      "/api/v1/watchers/x/runs/Q%2541",
      "/other/api/v1/instruments/x/runs/Q%2541",
      "/instruments/x/runs//files",
      "not a path",
    ])("returns the parameter for the path %s", (rawPath) => {
      expect(readRunIdParam(headersWith(rawPath), "from-param")).toBe(
        "from-param"
      );
    });

    it.each([
      ["a bare percent sign", "100%"],
      ["a percent sign and one digit", "100%2"],
      ["a percent sign and non-hex characters", "100%zz"],
      ["bytes that aren't UTF-8", "bad%FFbyte"],
      ["half of a UTF-8 character", "%E0%A4%A"],
    ])("returns the parameter for %s", (_name, encoded) => {
      expect(readRunIdParam(headersWith(apiPath(encoded)), "from-param")).toBe(
        "from-param"
      );
    });
  });
});
