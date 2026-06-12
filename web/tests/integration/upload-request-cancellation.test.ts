import { files, instruments } from "@/lib/db/schema";
import {
  api,
  closeTestDb,
  getTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// When a watcher's watch_directory changes, every still-pending upload
// request points at a relative path anchored to the old root and can no
// longer be resolved by the watcher. The config PUT handler reverts those
// files to `detected` (clearing upload_requested_at) so they drop out of the
// upload queue instead of erroring on every heartbeat poll (ENG-1397).
describe("Upload request cancellation on watch-directory change", () => {
  let token: string;
  let watcherId: string;
  const instrumentId = "cancel-on-dirchange-instrument";
  const runId = "cancel-on-dirchange-run";

  const configYamlFor = (dir: string): string =>
    [
      "version: 1",
      "instrument:",
      `  id: ${instrumentId}`,
      `  watch_directory: ${dir}`,
      "  file_patterns:",
      '    - "*.csv"',
      "",
    ].join("\n");

  beforeAll(async () => {
    await resetDb();
    ({ token } = await seedTestUser());

    const db = getTestDb();
    await db.insert(instruments).values({
      id: instrumentId,
      displayName: "Cancel-on-dir-change Instrument",
      status: "active",
    });

    const reg = await api("/api/v1/watchers/register", {
      method: "POST",
      token,
      body: { instrument_id: instrumentId, hostname: "lab-pc" },
    });
    watcherId = (await reg.json()).watcher_id;

    // First config push establishes the baseline watch directory. It must not
    // trigger a revert (no previous directory to diff against).
    await api(`/api/v1/watchers/${watcherId}/config`, {
      method: "PUT",
      token,
      body: {
        config_checksum: "sum-a",
        config_yaml: configYamlFor("/data/old"),
      },
    });

    await api(`/api/v1/instruments/${instrumentId}/runs`, {
      method: "POST",
      token,
      body: {
        run_id: runId,
        source: "watcher",
        detected_files: [
          { relative_path: "a.csv", filename: "a.csv", size_bytes: 1 },
          { relative_path: "b.csv", filename: "b.csv", size_bytes: 1 },
        ],
      },
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  async function fileIdsByName(): Promise<Record<string, number>> {
    const res = await api(`/api/v1/instruments/${instrumentId}/runs/${runId}`, {
      token,
    });
    const data = await res.json();
    const map: Record<string, number> = {};
    for (const f of data.files as { id: number; filename: string }[]) {
      map[f.filename] = f.id;
    }
    return map;
  }

  // Simulate a user requesting upload via the web UI (sets upload_requested_at)
  // by writing the queue state directly — the request-upload route is exercised
  // by its own suite; here we only need files in the queue to cancel.
  async function queueForUpload(ids: number[]): Promise<void> {
    await getTestDb()
      .update(files)
      .set({ status: "upload_requested", uploadRequestedAt: new Date() })
      .where(inArray(files.id, ids));
  }

  it("reverts pending requests to detected when watch_directory changes", async () => {
    const ids = await fileIdsByName();
    await queueForUpload([ids["a.csv"], ids["b.csv"]]);

    const before = await api(`/api/v1/watchers/${watcherId}/upload-queue`, {
      token,
    });
    expect((await before.json()).files).toHaveLength(2);

    const res = await api(`/api/v1/watchers/${watcherId}/config`, {
      method: "PUT",
      token,
      body: {
        config_checksum: "sum-b",
        config_yaml: configYamlFor("/data/new"),
      },
    });
    expect(res.status).toBe(200);

    // Queue drained.
    const after = await api(`/api/v1/watchers/${watcherId}/upload-queue`, {
      token,
    });
    expect((await after.json()).files).toHaveLength(0);

    // Files reverted to detected with upload_requested_at cleared.
    const detail = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}`,
      { token }
    );
    const detailData = await detail.json();
    for (const f of detailData.files as {
      status: string;
      upload_requested_at: string | null;
    }[]) {
      expect(f.status).toBe("detected");
      expect(f.upload_requested_at).toBeNull();
    }

    // A config_synced event records the cancellation for observability.
    const events = await api(
      `/api/v1/watchers/${watcherId}/events?event_type=config_synced`,
      { token }
    );
    const eventsData = await events.json();
    const cancelEvent = eventsData.data.find(
      (e: { details?: { kind?: string } }) =>
        e.details?.kind === "upload_requests_cancelled"
    );
    expect(cancelEvent).toBeTruthy();
    expect(cancelEvent.details.cancelled_count).toBe(2);
    expect(cancelEvent.details.previous_watch_directory).toBe("/data/old");
    expect(cancelEvent.details.watch_directory).toBe("/data/new");
  });

  it("does not revert when watch_directory is unchanged", async () => {
    const ids = await fileIdsByName();
    await queueForUpload([ids["a.csv"]]);

    // Same watch directory (only the checksum differs, as an unrelated config
    // edit would) — pending requests must survive.
    const res = await api(`/api/v1/watchers/${watcherId}/config`, {
      method: "PUT",
      token,
      body: {
        config_checksum: "sum-c",
        config_yaml: configYamlFor("/data/new"),
      },
    });
    expect(res.status).toBe(200);

    const queue = await api(`/api/v1/watchers/${watcherId}/upload-queue`, {
      token,
    });
    expect((await queue.json()).files).toHaveLength(1);
  });
});
