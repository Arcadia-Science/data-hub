import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { Crc64Nvme } from "@aws-sdk/crc64-nvme";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MULTIPART_MAX_PARTS,
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
});
