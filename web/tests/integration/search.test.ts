import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GlobalSearchResult } from "@/lib/api/search";
import { files, instrumentRuns, instruments, watchers } from "@/lib/db/schema";
import {
  api,
  closeTestDb,
  getTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";

// Seeds a run with the given files and returns the run's UUID.
async function seedRun(
  instrumentId: string,
  runId: string,
  filenames: string[]
): Promise<string> {
  const db = getTestDb();
  const [run] = await db
    .insert(instrumentRuns)
    .values({ instrumentId, runId })
    .returning({ id: instrumentRuns.id });
  if (filenames.length > 0) {
    await db.insert(files).values(
      filenames.map((filename, i) => ({
        instrumentRunId: run.id,
        filename,
        relativePath: filename,
        sizeBytes: (i + 1) * 1000,
      }))
    );
  }
  return run.id;
}

async function search(
  token: string,
  query: string,
  scope?: string
): Promise<GlobalSearchResult> {
  const params = new URLSearchParams({ q: query });
  if (scope) {
    params.set("scope", scope);
  }
  const res = await api(`/api/v1/search?${params}`, { token });
  expect(res.status).toBe(200);
  return (await res.json()) as GlobalSearchResult;
}

describe("Global search API", () => {
  let token: string;

  beforeAll(async () => {
    await resetDb();
    ({ token } = await seedTestUser());

    const db = getTestDb();
    await db.insert(instruments).values([
      {
        id: "hina-microscope",
        displayName: "Hina Microscope",
        status: "active",
      },
      { id: "plate-reader-x", displayName: "Plate Reader X", status: "active" },
    ]);

    // The Hina microscope watches for *.nd2; Plate Reader X watches for *.csv
    // but has no runs (exercises the zero-run pattern-match case).
    await db.insert(watchers).values([
      {
        instrumentId: "hina-microscope",
        hostname: "hina-pc",
        status: "watching",
        lastHeartbeatAt: new Date(),
        configYaml: 'instrument:\n  file_patterns:\n    - "*.nd2"\n',
      },
      {
        instrumentId: "plate-reader-x",
        hostname: "plate-pc",
        status: "watching",
        lastHeartbeatAt: new Date(),
        configYaml: 'instrument:\n  file_patterns:\n    - "*.csv"\n',
      },
    ]);

    await seedRun("hina-microscope", "20260706_112803_385", ["sample_012.nd2"]);
    await seedRun("hina-microscope", "20260630_101502_204", ["scan_009.nd2"]);
    // Literal special characters: `photo.*jpg` must match a `.*jpg` query while
    // `photoXjpg` must not (the query is never treated as a regex/glob).
    await seedRun("hina-microscope", "special-run", [
      "photo.*jpg",
      "photoXjpg",
    ]);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("requires authentication", async () => {
    const res = await api("/api/v1/search?q=nd2");
    expect(res.status).toBe(401);
  });

  it("returns an empty result below the minimum query length", async () => {
    const result = await search(token, "n");
    expect(result.counts.total).toBe(0);
    expect(result.runs).toHaveLength(0);
    expect(result.files).toHaveLength(0);
    expect(result.instruments).toHaveLength(0);
  });

  it("matches a run by its run id", async () => {
    const result = await search(token, "20260706");
    const run = result.runs.find((r) => r.runId === "20260706_112803_385");
    expect(run).toBeDefined();
    expect(run?.matchReason).toBe("run_id");
    expect(run?.matchedFilename).toBeNull();
  });

  it("surfaces runs, files, and the instrument together for a nested filename match", async () => {
    const result = await search(token, "nd2");

    // Both nd2-bearing runs surface, attributed to the contained file.
    const runIds = result.runs.map((r) => r.runId);
    expect(runIds).toContain("20260706_112803_385");
    expect(runIds).toContain("20260630_101502_204");
    const run = result.runs.find((r) => r.runId === "20260706_112803_385");
    expect(run?.matchReason).toBe("file");
    expect(run?.matchedFilename).toBe("sample_012.nd2");

    // The individual files surface in the Files group.
    const filenames = result.files.map((f) => f.filename);
    expect(filenames).toContain("sample_012.nd2");
    expect(filenames).toContain("scan_009.nd2");

    // The instrument surfaces via its configured *.nd2 pattern.
    const instrument = result.instruments.find(
      (i) => i.id === "hina-microscope"
    );
    expect(instrument).toBeDefined();
    expect(instrument?.matchReason).toBe("pattern");
    expect(instrument?.matchedPattern).toBe("*.nd2");
  });

  it("matches an instrument by display name", async () => {
    const result = await search(token, "Hina");
    const instrument = result.instruments.find(
      (i) => i.id === "hina-microscope"
    );
    expect(instrument).toBeDefined();
    expect(instrument?.matchReason).toBe("name");
  });

  it("scopes results to a single type when requested", async () => {
    const result = await search(token, "nd2", "runs");
    expect(result.runs.length).toBeGreaterThan(0);
    expect(result.files).toHaveLength(0);
    expect(result.instruments).toHaveLength(0);
  });

  it("treats special characters in the query literally, not as a pattern", async () => {
    const result = await search(token, ".*jpg", "files");
    const filenames = result.files.map((f) => f.filename);
    expect(filenames).toContain("photo.*jpg");
    expect(filenames).not.toContain("photoXjpg");
  });

  it("returns a pattern-matched instrument even when it has zero runs", async () => {
    const result = await search(token, "csv", "instruments");
    const instrument = result.instruments.find(
      (i) => i.id === "plate-reader-x"
    );
    expect(instrument).toBeDefined();
    expect(instrument?.matchReason).toBe("pattern");
    expect(instrument?.runCount).toBe(0);
  });
});
