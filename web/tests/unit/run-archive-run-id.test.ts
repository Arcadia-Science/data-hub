import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `prepareRunArchive` names the archive after the run. A request that has
// spaces around the run ID must get the archive of the run `RUN1`, not an
// archive of its own. The run row and S3 are replaced, so the test checks
// only which run ID the archive is named after.

const { lookupRunByNaturalKey, headS3Object, getPresignedDownloadUrl } =
  vi.hoisted(() => ({
    lookupRunByNaturalKey: vi.fn(),
    headS3Object: vi.fn(),
    getPresignedDownloadUrl: vi.fn(),
  }));

vi.mock("@/lib/api/instrument-runs", () => ({ lookupRunByNaturalKey }));
vi.mock("@/lib/s3", () => ({
  getS3ArchivesBucket: () => "archives-bucket",
  headS3Object,
  getPresignedDownloadUrl,
  PRESIGNED_DOWNLOAD_URL_EXPIRY_SECONDS: 600,
}));
vi.mock("@/lib/lambda", () => ({
  hasInvokeCredentials: () => true,
  signLambdaInvoke: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () =>
          Promise.resolve([
            {
              id: 1,
              filename: "a.csv",
              s3Bucket: "raw-bucket",
              s3Key: "inst/RUN1/a.csv",
              sizeBytes: 10,
            },
          ]),
      }),
    }),
  },
}));

import { prepareRunArchive } from "@/lib/api/run-archive";

describe("prepareRunArchive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("LAMBDA_FUNCTION_URL", "https://lambda.example.test/");
    vi.stubEnv("S3_ARCHIVES_BUCKET", "archives-bucket");
    lookupRunByNaturalKey.mockResolvedValue({
      id: "run-uuid",
      instrumentId: "inst",
      runId: "RUN1",
    });
    headS3Object.mockResolvedValue({ exists: true, sizeBytes: 10 });
    getPresignedDownloadUrl.mockResolvedValue("https://example.test/zip");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function readyArchive(runId: string) {
    const result = await prepareRunArchive({
      instrumentId: "inst",
      runId,
      actor: null,
    });
    if (!(result.ok && result.status === "ready")) {
      throw new Error("expected a ready archive");
    }
    return result;
  }

  it("names the archive after the stored run ID, not the one in the request", async () => {
    const result = await readyArchive(" RUN1 ");

    expect(result.filename).toBe("RUN1.zip");
    expect(result.archiveKey).toMatch(/^runs\/inst\/RUN1\/[0-9a-f]{64}\.zip$/);
    expect(getPresignedDownloadUrl).toHaveBeenCalledWith(
      "archives-bucket",
      result.archiveKey,
      expect.objectContaining({ filename: "RUN1.zip" })
    );
  });

  it("gives the same archive key with and without the spaces", async () => {
    const withSpaces = await readyArchive(" RUN1 ");
    const without = await readyArchive("RUN1");

    expect(withSpaces.archiveKey).toBe(without.archiveKey);
  });
});
