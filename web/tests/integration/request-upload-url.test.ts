import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Crc64Nvme } from "@aws-sdk/crc64-nvme";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uploadUrlResponse } from "@/lib/api/openapi";
import { WATCHER_VERSION_HEADER } from "@/lib/api/watcher-compat";
import { files, instruments } from "@/lib/db/schema";
import { SINGLE_PUT_MAX_BYTES } from "@/lib/multipart";
import {
  api,
  closeTestDb,
  getBaseUrl,
  getTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";

describe("Request Upload URL API", () => {
  let token: string;
  const instrumentId = "upload-url-test-instrument";
  const runId = "upload-url-test-run";

  beforeAll(async () => {
    await resetDb();
    ({ token } = await seedTestUser());

    const db = getTestDb();
    await db.insert(instruments).values({
      id: instrumentId,
      displayName: "Upload URL Test Instrument",
      status: "active",
    });

    await api(`/api/v1/instruments/${instrumentId}/runs`, {
      method: "POST",
      token,
      body: {
        run_id: runId,
        source: "watcher",
        detected_files: [
          {
            relative_path: "existing.csv",
            filename: "existing.csv",
            size_bytes: 512,
          },
        ],
      },
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it("returns presigned URL for a new file in a valid run", async () => {
    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/request-upload-url`,
      {
        method: "POST",
        token,
        body: { filename: "new_data.csv", content_type: "text/csv" },
      }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.upload_url).toBeTruthy();
    expect(data.s3_bucket).toBeTruthy();
    expect(data.s3_key).toBe(`${instrumentId}/${runId}/new_data.csv`);
    expect(data.file_id).toBeGreaterThan(0);
    expect(data.expires_in).toBe(3600);
    expect(data.already_uploaded).toBe(false);
    // Drift guard: the live response must match its documented OpenAPI schema
    // (responses aren't validated at runtime, so this is the only backstop).
    uploadUrlResponse.parse(data);
  });

  it("creates a file record if none exists", async () => {
    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/request-upload-url`,
      {
        method: "POST",
        token,
        body: { filename: "brand_new.csv" },
      }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.file_id).toBeGreaterThan(0);
    expect(data.already_uploaded).toBe(false);
  });

  it("reuses existing detected file record", async () => {
    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/request-upload-url`,
      {
        method: "POST",
        token,
        body: { filename: "existing.csv" },
      }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.already_uploaded).toBe(false);
    expect(data.upload_url).toBeTruthy();
  });

  it("returns already_uploaded for files past uploaded status", async () => {
    // First, get a presigned URL and the file_id for a new file
    const urlRes = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/request-upload-url`,
      {
        method: "POST",
        token,
        body: { filename: "already_done.csv" },
      }
    );
    const urlData = await urlRes.json();
    const fileId = urlData.file_id;

    // Mark it as uploaded via PATCH
    await api(`/api/v1/files/${fileId}`, {
      method: "PATCH",
      token,
      body: {
        status: "uploaded",
        s3_bucket: "test-bucket",
        s3_key: `${instrumentId}/${runId}/already_done.csv`,
      },
    });

    // Request again — should short-circuit
    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/request-upload-url`,
      {
        method: "POST",
        token,
        body: { filename: "already_done.csv" },
      }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.already_uploaded).toBe(true);
    expect(data.file_id).toBe(fileId);
    uploadUrlResponse.parse(data);
  });

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  it("rejects missing filename", async () => {
    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/request-upload-url`,
      {
        method: "POST",
        token,
        body: {},
      }
    );
    expect(res.status).toBe(400);
  });

  // Path traversal guard: the filename is persisted as
  // `relative_path` and joined into the S3 key, so a `..`/absolute value must
  // be rejected before it can reach the watcher's upload queue.
  it.each([
    "../../etc/passwd",
    "../escape.csv",
    "sub/../../escape.csv",
    "/etc/passwd",
    "C:\\Windows\\system32\\config\\SAM",
    "..\\..\\secret.csv",
  ])("rejects unsafe filename %s", async (bad) => {
    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/request-upload-url`,
      {
        method: "POST",
        token,
        body: { filename: bad },
      }
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 for nonexistent instrument/run", async () => {
    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/nonexistent-run/request-upload-url`,
      {
        method: "POST",
        token,
        body: { filename: "data.csv" },
      }
    );
    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  const watcher12 = { [WATCHER_VERSION_HEADER]: "1.2.0" };

  it("refuses files over 5 GB from a watcher that cannot split uploads", async () => {
    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/request-upload-url`,
      {
        method: "POST",
        token,
        body: {
          filename: "too-big.tif",
          size_bytes: SINGLE_PUT_MAX_BYTES + 1,
        },
      }
    );
    expect(res.status).toBe(413);
    const data = await res.json();
    expect(data.error.message).toContain("1.2.0");
  });

  it("uploads a file in parts and replaces an unfinished upload", async () => {
    const body = Buffer.alloc(1500, 7);
    const checksum = new Crc64Nvme();
    checksum.update(body);
    const crc = Buffer.from(await checksum.digest()).toString("base64");
    const headers = watcher12;

    const first = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/request-upload-url`,
      {
        method: "POST",
        token,
        headers,
        body: {
          filename: "parts.bin",
          content_type: "application/octet-stream",
          size_bytes: body.length,
        },
      }
    );
    expect(first.status).toBe(200);
    const started = await first.json();
    uploadUrlResponse.parse(started);
    expect(started.upload_type).toBe("multipart");
    expect(started.part_size).toBe(1024);
    expect(started.part_count).toBe(2);

    const second = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/request-upload-url`,
      {
        method: "POST",
        token,
        headers,
        body: {
          filename: "parts.bin",
          size_bytes: body.length,
        },
      }
    );
    const restarted = await second.json();
    expect(restarted.upload_id).not.toBe(started.upload_id);

    const badPart = await api(
      `/api/v1/files/${restarted.file_id}/multipart-upload/part-urls`,
      {
        method: "POST",
        token,
        body: { upload_id: restarted.upload_id, part_numbers: [9] },
      }
    );
    expect(badPart.status).toBe(400);

    const urls = await api(
      `/api/v1/files/${restarted.file_id}/multipart-upload/part-urls`,
      {
        method: "POST",
        token,
        body: { upload_id: restarted.upload_id, part_numbers: [1, 2] },
      }
    );
    expect(urls.status).toBe(200);
    const signed = await urls.json();
    const parts: { part_number: number; etag: string }[] = [];
    for (const part of signed.parts) {
      const start = (part.part_number - 1) * started.part_size;
      const put = await fetch(`${getBaseUrl()}${part.upload_url}`, {
        method: "PUT",
        body: body.subarray(start, start + started.part_size),
      });
      expect(put.status).toBe(200);
      const etag = put.headers.get("etag");
      expect(etag).toBeTruthy();
      parts.push({ part_number: part.part_number, etag: etag ?? "" });
    }

    const done = await api(
      `/api/v1/files/${restarted.file_id}/multipart-upload/complete`,
      {
        method: "POST",
        token,
        body: {
          upload_id: restarted.upload_id,
          checksum_crc64nvme: crc,
          parts,
        },
      }
    );
    expect(done.status).toBe(200);
    const finished = await done.json();
    expect(finished.already_uploaded).toBe(false);

    const db = getTestDb();
    const [row] = await db
      .select()
      .from(files)
      .where(eq(files.id, restarted.file_id));
    expect(row?.status).toBe("uploaded");
    expect(row?.multipartUploadId).toBeNull();
    expect(row?.s3Key).toBe(`${instrumentId}/${runId}/parts.bin`);
    expect(row?.contentType).toBe("application/octet-stream");
  });

  it("finishes when S3 already assembled the object", async () => {
    const body = Buffer.alloc(1200, 3);
    const checksum = new Crc64Nvme();
    checksum.update(body);
    const crc = Buffer.from(await checksum.digest()).toString("base64");
    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/request-upload-url`,
      {
        method: "POST",
        token,
        headers: watcher12,
        body: { filename: "recovered.bin", size_bytes: body.length },
      }
    );
    const started = await res.json();
    const mirrorFile = path.join(
      "/tmp/data-hub-integration-s3",
      "test-raw-data-bucket",
      instrumentId,
      runId,
      "recovered.bin"
    );
    await mkdir(path.dirname(mirrorFile), { recursive: true });
    await writeFile(mirrorFile, body);
    await rm(
      path.join(
        "/tmp/data-hub-integration-s3",
        ".multipart",
        started.upload_id
      ),
      { recursive: true, force: true }
    );

    const done = await api(
      `/api/v1/files/${started.file_id}/multipart-upload/complete`,
      {
        method: "POST",
        token,
        body: {
          upload_id: started.upload_id,
          checksum_crc64nvme: crc,
          parts: [
            { part_number: 1, etag: '"missing"' },
            { part_number: 2, etag: '"missing"' },
          ],
        },
      }
    );
    expect(done.status).toBe(200);
    const finished = await done.json();
    expect(finished.already_uploaded).toBe(false);
    const [row] = await getTestDb()
      .select()
      .from(files)
      .where(eq(files.id, started.file_id));
    expect(row?.status).toBe("uploaded");
  });

  it("leaves a file the processor already took and clears the upload id", async () => {
    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/request-upload-url`,
      {
        method: "POST",
        token,
        headers: watcher12,
        body: { filename: "adopted.bin", size_bytes: 1200 },
      }
    );
    const started = await res.json();
    await getTestDb()
      .update(files)
      .set({ status: "processing" })
      .where(eq(files.id, started.file_id));

    const done = await api(
      `/api/v1/files/${started.file_id}/multipart-upload/complete`,
      {
        method: "POST",
        token,
        body: {
          upload_id: started.upload_id,
          checksum_crc64nvme: "AuUcyF784aU=",
          parts: [{ part_number: 1, etag: '"unused"' }],
        },
      }
    );
    expect(done.status).toBe(200);
    const finished = await done.json();
    expect(finished.already_uploaded).toBe(true);
    expect(finished.status).toBe("processing");
    const [row] = await getTestDb()
      .select()
      .from(files)
      .where(eq(files.id, started.file_id));
    expect(row?.status).toBe("processing");
    expect(row?.multipartUploadId).toBeNull();
  });

  it("requires authentication", async () => {
    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/request-upload-url`,
      {
        method: "POST",
        body: { filename: "data.csv" },
      }
    );
    expect(res.status).toBe(401);
  });
});
