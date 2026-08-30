import { describe, expect, it } from "vitest";
import {
  localS3CorsPreflight,
  withLocalS3Cors,
} from "@/lib/s3-local-mirror-cors";

describe("local S3 CORS", () => {
  it("answers preflight for GET without allowing PUT", () => {
    const response = localS3CorsPreflight();
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, HEAD, OPTIONS"
    );
    expect(response.headers.get("Access-Control-Allow-Methods")).not.toMatch(
      /PUT/
    );
  });

  it("copies CORS onto an existing response", async () => {
    const inner = new Response("ok", {
      status: 200,
      headers: { "Content-Type": "text/csv" },
    });
    const wrapped = withLocalS3Cors(inner);
    expect(wrapped.status).toBe(200);
    expect(wrapped.headers.get("Content-Type")).toBe("text/csv");
    expect(wrapped.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await wrapped.text()).toBe("ok");
  });
});
