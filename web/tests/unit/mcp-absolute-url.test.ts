import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  authBaseURL: "http://localhost:3000",
}));

import { toAbsoluteDownloadUrl } from "@/lib/mcp/absolute-url";

describe("toAbsoluteDownloadUrl", () => {
  it("leaves http(s) URLs unchanged", () => {
    expect(
      toAbsoluteDownloadUrl("https://bucket.s3.us-west-1.amazonaws.com/k")
    ).toBe("https://bucket.s3.us-west-1.amazonaws.com/k");
    expect(
      toAbsoluteDownloadUrl("http://127.0.0.1:3000/api/local-s3/b/k")
    ).toBe("http://127.0.0.1:3000/api/local-s3/b/k");
  });

  it("prefixes a relative local-mirror path with the auth origin", () => {
    expect(toAbsoluteDownloadUrl("/api/local-s3/raw/run/file.png")).toBe(
      "http://localhost:3000/api/local-s3/raw/run/file.png"
    );
    expect(toAbsoluteDownloadUrl("api/local-s3/raw/run/file.png")).toBe(
      "http://localhost:3000/api/local-s3/raw/run/file.png"
    );
  });
});
