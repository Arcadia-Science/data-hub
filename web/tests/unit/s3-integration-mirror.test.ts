import { mkdir, mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PUT } from "@/app/api/local-s3/[bucket]/[...key]/route";
import {
  integrationTestMirrorRoot,
  localMirrorUploadUrl,
  mirrorRootForUploads,
} from "@/lib/s3-local-mirror";

// Each test gets a fresh parent folder with the mirror inside `mirror/`. A
// traversal that escapes the mirror lands in the parent, where the test can
// see it.
let outer: string;
let root: string;

beforeEach(async () => {
  outer = await mkdtemp(path.join(tmpdir(), "integration-mirror-"));
  root = path.join(outer, "mirror");
  await mkdir(root);
  // Only the integration stand-in is on. VERCEL is cleared here so each test
  // turns it on on purpose.
  vi.stubEnv("LOCAL_S3_MIRROR", "");
  vi.stubEnv("VERCEL", "");
  vi.stubEnv("INTEGRATION_TEST_S3_MIRROR", root);
  // Fake credentials let the AWS presign path sign locally, without a network
  // call.
  vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIDEXAMPLE");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "secret");
  vi.stubEnv("AWS_REGION", "us-west-1");
  vi.stubEnv("AWS_ROLE_ARN", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function routeContext(bucket: string, key: string) {
  return { params: Promise.resolve({ bucket, key: key.split("/") }) };
}

// The route reads only `request.url` and `request.body`, so a plain Request
// stands in for NextRequest.
function putRequest(bucket: string, key: string, body: string): NextRequest {
  const url = new URL(
    localMirrorUploadUrl(bucket, key),
    "http://localhost:3000"
  );
  return new Request(url, { method: "PUT", body }) as unknown as NextRequest;
}

describe("mirrorRootForUploads", () => {
  it("uses the integration mirror when the dev mirror is off", () => {
    expect(mirrorRootForUploads()).toBe(path.resolve(root));
  });

  it("prefers the dev mirror when LOCAL_S3_MIRROR is set", () => {
    const dev = path.join(outer, "dev");
    vi.stubEnv("LOCAL_S3_MIRROR", dev);
    expect(mirrorRootForUploads()).toBe(path.resolve(dev));
  });

  it("returns no root on Vercel", () => {
    vi.stubEnv("VERCEL", "1");
    expect(integrationTestMirrorRoot()).toBeNull();
    expect(mirrorRootForUploads()).toBeNull();
  });
});

describe("getPresignedUploadUrl under the integration mirror", () => {
  it("returns the same-origin local URL when VERCEL is unset", async () => {
    const { getPresignedUploadUrl } = await import("@/lib/s3");
    await expect(
      getPresignedUploadUrl("bucket", "inst/run/file.csv", "text/csv")
    ).resolves.toBe("/api/local-s3/bucket/inst/run/file.csv");
  });

  it("keeps the AWS presigned URL when VERCEL is set", async () => {
    vi.stubEnv("VERCEL", "1");
    const { getPresignedUploadUrl } = await import("@/lib/s3");
    const url = new URL(
      await getPresignedUploadUrl("bucket", "inst/run/file.csv", "text/csv")
    );
    expect(url.origin).toBe("https://bucket.s3.us-west-1.amazonaws.com");
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
  });
});

describe("whole-file PUT on the local-s3 route", () => {
  it("writes the body to <root>/<bucket>/<key>", async () => {
    const response = await PUT(
      putRequest("bucket", "inst/run/file.csv", "a,b\n1,2\n"),
      routeContext("bucket", "inst/run/file.csv")
    );
    expect(response.status).toBe(200);
    await expect(
      readFile(path.join(root, "bucket", "inst", "run", "file.csv"), "utf8")
    ).resolves.toBe("a,b\n1,2\n");
  });

  it("rejects bucket or key segments that escape the mirror root", async () => {
    const attempts: [string, string][] = [
      ["bucket", "../../escaped.txt"],
      ["..", "escaped.txt"],
      ["bucket", "inst/../../../escaped.txt"],
    ];
    for (const [bucket, key] of attempts) {
      const response = await PUT(
        putRequest(bucket, key, "nope"),
        routeContext(bucket, key)
      );
      expect(response.status).toBe(400);
    }
    // Nothing was written next to the mirror root.
    expect(await readdir(outer)).toEqual(["mirror"]);
  });

  it("404s on Vercel even when the integration mirror is set", async () => {
    vi.stubEnv("VERCEL", "1");
    const response = await PUT(
      putRequest("bucket", "inst/run/file.csv", "x"),
      routeContext("bucket", "inst/run/file.csv")
    );
    expect(response.status).toBe(404);
    await expect(
      stat(path.join(root, "bucket", "inst", "run", "file.csv"))
    ).rejects.toThrow();
  });
});
