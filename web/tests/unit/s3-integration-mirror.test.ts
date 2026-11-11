import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, HEAD, PUT } from "@/app/api/local-s3/[bucket]/[...key]/route";
import {
  integrationTestMirrorRoot,
  localCreateMultipartUpload,
  localMirrorUploadUrl,
  localSavePart,
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

// A PUT whose body delivers `chunks` and then fails, as when the sender
// disconnects part-way through.
function interruptedPutRequest(
  bucket: string,
  key: string,
  chunks: string[]
): NextRequest {
  const url = new URL(
    localMirrorUploadUrl(bucket, key),
    "http://localhost:3000"
  );
  const encoder = new TextEncoder();
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent < chunks.length) {
        controller.enqueue(encoder.encode(chunks[sent]));
        sent += 1;
        return;
      }
      controller.error(new Error("connection reset"));
    },
  });
  return new Request(url, {
    method: "PUT",
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" }) as unknown as NextRequest;
}

function getRequest(bucket: string, key: string, method: "GET" | "HEAD") {
  const url = new URL(
    localMirrorUploadUrl(bucket, key),
    "http://localhost:3000"
  );
  return new Request(url, { method }) as unknown as NextRequest;
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

describe("an interrupted whole-file PUT", () => {
  const key = "inst/run/file.csv";

  it("stores nothing at the key, as S3 does for an aborted PUT", async () => {
    await expect(
      PUT(
        interruptedPutRequest("bucket", key, ["a,b\n", "1,2\n"]),
        routeContext("bucket", key)
      )
    ).rejects.toThrow("connection reset");

    const folder = path.join(root, "bucket", "inst", "run");
    await expect(stat(path.join(folder, "file.csv"))).rejects.toThrow();
    // ...and no temporary file is left next to where it would have been.
    expect(await readdir(folder)).toEqual([]);
  });

  it("leaves an earlier object at the key as it was", async () => {
    await PUT(
      putRequest("bucket", key, "old,bytes\n"),
      routeContext("bucket", key)
    );

    await expect(
      PUT(
        interruptedPutRequest("bucket", key, ["new"]),
        routeContext("bucket", key)
      )
    ).rejects.toThrow("connection reset");

    const folder = path.join(root, "bucket", "inst", "run");
    await expect(readFile(path.join(folder, "file.csv"), "utf8")).resolves.toBe(
      "old,bytes\n"
    );
    expect(await readdir(folder)).toEqual(["file.csv"]);
  });

  it("leaves nothing but the object after a complete PUT", async () => {
    const response = await PUT(
      putRequest("bucket", key, "a,b\n"),
      routeContext("bucket", key)
    );

    expect(response.status).toBe(200);
    expect(await readdir(path.join(root, "bucket", "inst", "run"))).toEqual([
      "file.csv",
    ]);
  });
});

describe("an interrupted multipart part PUT", () => {
  function interruptedPart(first: string): Readable {
    return Readable.from(
      (function* () {
        yield Buffer.from(first);
        throw new Error("connection reset");
      })()
    );
  }

  async function startUpload(): Promise<{
    uploadId: string;
    partsDir: string;
  }> {
    const uploadId = await localCreateMultipartUpload(
      root,
      "bucket",
      "inst/run/big.bin"
    );
    return {
      uploadId,
      partsDir: path.join(root, ".multipart", uploadId, "parts"),
    };
  }

  it("stores no part", async () => {
    const { uploadId, partsDir } = await startUpload();

    await expect(
      localSavePart(root, uploadId, 1, interruptedPart("par"))
    ).rejects.toThrow("connection reset");

    expect(await readdir(partsDir)).toEqual([]);
  });

  it("leaves an earlier upload of the same part as it was", async () => {
    const { uploadId, partsDir } = await startUpload();
    const etag = await localSavePart(
      root,
      uploadId,
      1,
      Readable.from([Buffer.from("good bytes")])
    );

    await expect(
      localSavePart(root, uploadId, 1, interruptedPart("par"))
    ).rejects.toThrow("connection reset");

    await expect(readFile(path.join(partsDir, "1"), "utf8")).resolves.toBe(
      "good bytes"
    );
    expect(await readdir(partsDir)).toEqual(["1"]);
    // A retry that completes replaces it, and the ETag is that of the new bytes.
    const retried = await localSavePart(
      root,
      uploadId,
      1,
      Readable.from([Buffer.from("good bytes")])
    );
    expect(retried).toBe(etag);
  });

  it("leaves nothing but the part after a complete PUT", async () => {
    const { uploadId, partsDir } = await startUpload();

    const etag = await localSavePart(
      root,
      uploadId,
      2,
      Readable.from([Buffer.from("abc")])
    );

    expect(etag).toBe('"900150983cd24fb0d6963f7d28e17f72"');
    expect(await readdir(partsDir)).toEqual(["2"]);
  });
});

describe("GET and HEAD on the local-s3 route", () => {
  const key = "inst/run/file.csv";

  async function storeObject(): Promise<void> {
    await mkdir(path.join(root, "bucket", "inst", "run"), { recursive: true });
    await writeFile(path.join(root, "bucket", key), "a,b\n1,2\n");
  }

  it("404 when only the integration mirror is active, even for a stored object", async () => {
    await storeObject();

    const get = await GET(
      getRequest("bucket", key, "GET"),
      routeContext("bucket", key)
    );
    const head = await HEAD(
      getRequest("bucket", key, "HEAD"),
      routeContext("bucket", key)
    );

    expect(get.status).toBe(404);
    expect(head.status).toBe(404);
  });

  it("serve the object when the dev mirror is on", async () => {
    // The same request as above, so the 404s there come from the mirror being
    // off and not from a wrong path.
    await storeObject();
    vi.stubEnv("LOCAL_S3_MIRROR", root);

    const get = await GET(
      getRequest("bucket", key, "GET"),
      routeContext("bucket", key)
    );
    const head = await HEAD(
      getRequest("bucket", key, "HEAD"),
      routeContext("bucket", key)
    );

    expect(get.status).toBe(200);
    expect(await get.text()).toBe("a,b\n1,2\n");
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Length")).toBe("8");
  });
});
