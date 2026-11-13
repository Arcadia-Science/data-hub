import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `prepareRunArchive` names the archive after the run, and tells the Lambda
// which run it builds. A request that has spaces around the run ID must get
// the archive of the run `RUN1`, not an archive of its own. The run row, S3,
// the database and the Lambda call are replaced, so the test checks only which
// run ID they get.

const {
  lookupRunByNaturalKey,
  headS3Object,
  getPresignedDownloadUrl,
  invokeBuildArchive,
  afterCallbacks,
} = vi.hoisted(() => ({
  lookupRunByNaturalKey: vi.fn(),
  headS3Object: vi.fn(),
  getPresignedDownloadUrl: vi.fn(),
  invokeBuildArchive: vi.fn(),
  afterCallbacks: [] as (() => unknown)[],
}));

vi.mock("@/lib/api/instrument-runs", () => ({ lookupRunByNaturalKey }));
// `after` keeps its callback, so the test decides when the Lambda call runs.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (callback: () => unknown) => {
    afterCallbacks.push(callback);
  },
}));
vi.mock("@/lib/api/archive-builder", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/archive-builder")>()),
  invokeBuildArchive,
}));
vi.mock("@/lib/api/archive-jobs", () => ({
  expireStaleArchiveJobs: vi.fn().mockResolvedValue(0),
}));
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
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: () => Promise.resolve([{ id: "job-1" }]),
        }),
      }),
    }),
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
    afterCallbacks.length = 0;
    vi.stubEnv("LAMBDA_FUNCTION_URL", "https://lambda.example.test/");
    vi.stubEnv("S3_ARCHIVES_BUCKET", "archives-bucket");
    lookupRunByNaturalKey.mockResolvedValue({
      id: "run-uuid",
      instrumentId: "inst",
      runId: "RUN1",
      deletedAt: null,
      attributions: [],
    });
    headS3Object.mockResolvedValue({ exists: true, sizeBytes: 10 });
    getPresignedDownloadUrl.mockResolvedValue("https://example.test/zip");
    invokeBuildArchive.mockResolvedValue({ ok: true });
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
    expect(result.runId).toBe("RUN1");
    expect(result.archiveKey).toMatch(/^runs\/inst\/RUN1\/[0-9a-f]{64}\.zip$/);
    expect(getPresignedDownloadUrl).toHaveBeenCalledWith(
      "archives-bucket",
      result.archiveKey,
      expect.objectContaining({ filename: "RUN1.zip" })
    );
  });

  it("starts the build with the stored run ID, not the one in the request", async () => {
    headS3Object.mockResolvedValue({ exists: false });

    const result = await prepareRunArchive({
      instrumentId: "inst",
      runId: " RUN1 ",
      actor: null,
    });

    expect(result).toMatchObject({
      ok: true,
      status: "building",
      jobId: "job-1",
      runId: "RUN1",
      ownsBuild: true,
    });
    // The Lambda call runs after the response, so run what `after` kept.
    await Promise.all(afterCallbacks.map((callback) => callback()));
    expect(invokeBuildArchive).toHaveBeenCalledTimes(1);
    const [buildInput, fingerprint] = invokeBuildArchive.mock.calls[0];
    expect(buildInput).toMatchObject({
      jobId: "job-1",
      instrumentId: "inst",
      runId: "RUN1",
    });
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives the same archive key with and without the spaces", async () => {
    const withSpaces = await readyArchive(" RUN1 ");
    const without = await readyArchive("RUN1");

    expect(withSpaces.archiveKey).toBe(without.archiveKey);
  });

  // `get_run_archive` passes this on so the assistant can offer `claim_run`.
  it("says whether the run is unclaimed, counting a deleted run as claimed", async () => {
    expect((await readyArchive("RUN1")).unclaimed).toBe(true);

    lookupRunByNaturalKey.mockResolvedValue({
      id: "run-uuid",
      instrumentId: "inst",
      runId: "RUN1",
      deletedAt: null,
      attributions: [{ userId: "user-alice" }],
    });
    expect((await readyArchive("RUN1")).unclaimed).toBe(false);

    lookupRunByNaturalKey.mockResolvedValue({
      id: "run-uuid",
      instrumentId: "inst",
      runId: "RUN1",
      deletedAt: new Date("2026-01-01T00:00:00.000Z"),
      attributions: [],
    });
    expect((await readyArchive("RUN1")).unclaimed).toBe(false);
  });
});
