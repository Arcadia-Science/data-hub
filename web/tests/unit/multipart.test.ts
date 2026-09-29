import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { Crc64Nvme } from "@aws-sdk/crc64-nvme";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MULTIPART_MAX_PARTS,
  MULTIPART_MIN_PART_BYTES,
  MULTIPART_PART_SIZE_BYTES,
  planMultipartUpload,
} from "@/lib/multipart";
import {
  localCompleteMultipartUpload,
  localCreateMultipartUpload,
  localSavePart,
  MirrorMultipartError,
} from "@/lib/s3-local-mirror";

async function crc64(bytes: Uint8Array): Promise<string> {
  const checksum = new Crc64Nvme();
  checksum.update(bytes);
  return Buffer.from(await checksum.digest()).toString("base64");
}

describe("planMultipartUpload", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses 64 MiB parts until the part count would pass 10000", () => {
    vi.stubEnv("MULTIPART_PART_SIZE_BYTES", "");
    const small = planMultipartUpload(200 * 1024 * 1024);
    expect(small.partSize).toBe(MULTIPART_PART_SIZE_BYTES);
    expect(small.partCount).toBe(4);

    const huge = MULTIPART_PART_SIZE_BYTES * MULTIPART_MAX_PARTS + 1;
    const large = planMultipartUpload(huge);
    expect(large.partCount).toBeLessThanOrEqual(MULTIPART_MAX_PARTS);
    expect(large.partSize).toBeGreaterThan(MULTIPART_PART_SIZE_BYTES);
  });

  it("keeps a tiny part size for the stand-in and raises it otherwise", () => {
    vi.stubEnv("MULTIPART_PART_SIZE_BYTES", "1024");
    vi.stubEnv("LOCAL_S3_MIRROR", "");
    vi.stubEnv("INTEGRATION_TEST_S3_MIRROR", "/tmp/mirror");
    vi.stubEnv("VERCEL", "");
    expect(planMultipartUpload(2048).partSize).toBe(1024);

    vi.stubEnv("INTEGRATION_TEST_S3_MIRROR", "");
    vi.stubEnv("VERCEL", "1");
    expect(planMultipartUpload(20 * 1024 * 1024).partSize).toBe(
      MULTIPART_MIN_PART_BYTES
    );
  });
});

describe("local multipart mirror", () => {
  it("joins parts and checks the CRC64NVME checksum", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "multipart-"));
    const body = Buffer.from("Hello World!");
    const uploadId = await localCreateMultipartUpload(
      root,
      "bucket",
      "inst/run/hello.txt",
      "text/plain"
    );
    const first = await localSavePart(
      root,
      uploadId,
      1,
      Readable.from(body.subarray(0, 6))
    );
    const second = await localSavePart(
      root,
      uploadId,
      2,
      Readable.from(body.subarray(6))
    );

    await localCompleteMultipartUpload(
      root,
      uploadId,
      [
        { partNumber: 1, etag: first },
        { partNumber: 2, etag: second },
      ],
      await crc64(body),
      body.length
    );

    const stored = await stat(path.join(root, "bucket/inst/run/hello.txt"));
    expect(stored.size).toBe(body.length);
    expect(await crc64(body)).toBe("AuUcyF784aU=");
  });

  it("rejects a checksum mismatch and does not keep the object", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "multipart-"));
    const uploadId = await localCreateMultipartUpload(
      root,
      "bucket",
      "inst/run/hello.txt"
    );
    const etag = await localSavePart(
      root,
      uploadId,
      1,
      Readable.from(Buffer.from("Hello World!"))
    );

    await expect(
      localCompleteMultipartUpload(
        root,
        uploadId,
        [{ partNumber: 1, etag }],
        "not-the-checksum",
        12
      )
    ).rejects.toBeInstanceOf(MirrorMultipartError);

    await expect(
      stat(path.join(root, "bucket/inst/run/hello.txt"))
    ).rejects.toThrow();
  });
});

describe("presigned upload URLs", () => {
  it("does not sign a checksum into PUT or UploadPart URLs", async () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIDEXAMPLE");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "secret");
    vi.stubEnv("AWS_SESSION_TOKEN", "token");
    vi.stubEnv("AWS_REGION", "us-west-1");
    vi.stubEnv("AWS_ROLE_ARN", "");
    vi.stubEnv("LOCAL_S3_MIRROR", "");
    vi.stubEnv("INTEGRATION_TEST_S3_MIRROR", "");
    const { getPresignedUploadPartUrl, getPresignedUploadUrl } = await import(
      "@/lib/s3"
    );
    const put = new URL(
      await getPresignedUploadUrl("bucket", "inst/run/file.bin", "image/tiff")
    );
    const part = new URL(
      await getPresignedUploadPartUrl(
        "bucket",
        "inst/run/file.bin",
        "upload",
        1
      )
    );
    for (const url of [put, part]) {
      const checksumParams = [...url.searchParams.keys()].filter((key) =>
        key.toLowerCase().includes("checksum")
      );
      expect(checksumParams).toEqual([]);
    }
  });

  it("sends the content type and a whole-file CRC64NVME checksum", async () => {
    vi.stubEnv("LOCAL_S3_MIRROR", "");
    vi.stubEnv("INTEGRATION_TEST_S3_MIRROR", "");
    vi.stubEnv("VERCEL", "1");
    const s3 = await import("@aws-sdk/client-s3");
    const send = vi
      .spyOn(s3.S3Client.prototype, "send")
      .mockResolvedValue({ UploadId: "upload-1" } as never);
    try {
      const { completeMultipartUpload, createMultipartUpload } = await import(
        "@/lib/s3"
      );
      await createMultipartUpload("bucket", "inst/run/file.tif", "image/tiff");
      await completeMultipartUpload({
        bucket: "bucket",
        key: "inst/run/file.tif",
        uploadId: "upload-1",
        parts: [{ partNumber: 1, etag: '"abc"' }],
        checksumCrc64nvme: "AuUcyF784aU=",
        sizeBytes: 12,
      });
      const commands = send.mock.calls.map((call) => call[0]);
      const created = commands.find(
        (command) => command instanceof s3.CreateMultipartUploadCommand
      );
      const finished = commands.find(
        (command) => command instanceof s3.CompleteMultipartUploadCommand
      );
      expect(created?.input).toMatchObject({
        ContentType: "image/tiff",
        ChecksumAlgorithm: "CRC64NVME",
        ChecksumType: "FULL_OBJECT",
      });
      expect(finished?.input).toMatchObject({
        ChecksumCRC64NVME: "AuUcyF784aU=",
        ChecksumType: "FULL_OBJECT",
        MpuObjectSize: 12,
      });
    } finally {
      send.mockRestore();
    }
  });
});

describe("multipart S3 errors", () => {
  it("returns 400 when the watcher can fix the bytes and 502 otherwise", async () => {
    const { multipartErrorResponse } = await import(
      "@/lib/api/multipart-upload"
    );
    const { MultipartUploadError } = await import("@/lib/s3");
    const mismatch = multipartErrorResponse(
      new MultipartUploadError("BadDigest", "checksum mismatch", 400)
    );
    expect(mismatch.status).toBe(400);
    const body = await mismatch.json();
    expect(body.error.details.s3_code).toBe("BadDigest");

    const denied = multipartErrorResponse(
      new MultipartUploadError("AccessDenied", "not allowed", 403)
    );
    expect(denied.status).toBe(502);
  });
});
