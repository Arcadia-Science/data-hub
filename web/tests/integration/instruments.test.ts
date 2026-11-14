import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getInstrumentById } from "@/lib/api/instruments";
import {
  instrumentDetail,
  instrumentListItem,
  instrumentRecord,
} from "@/lib/api/openapi";
import { instruments, watcherConfigRevisions, watchers } from "@/lib/db/schema";
import {
  api,
  closeTestDb,
  getTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";

describe("Instruments API", () => {
  let token: string;

  beforeAll(async () => {
    await resetDb();
    ({ token } = await seedTestUser());
  });

  afterAll(async () => {
    await closeTestDb();
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/instruments
  // -------------------------------------------------------------------------

  // New instruments always start as "pending" until an admin confirms them.
  // This prevents unvetted instruments from appearing in the active dashboard.
  it("POST /api/v1/instruments creates an instrument", async () => {
    const res = await api("/api/v1/instruments", {
      method: "POST",
      token,
      body: { id: "test-instrument", display_name: "Test Instrument" },
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.id).toBe("test-instrument");
    expect(data.display_name).toBe("Test Instrument");
    expect(data.status).toBe("pending");
    // Drift guard: live responses must match their documented OpenAPI schemas
    // (responses aren't validated at runtime, so this is the only backstop).
    instrumentRecord.parse(data);
    expect(data).not.toHaveProperty("watcher");
  });

  // When no display_name is provided, the API derives one from the kebab-case
  // id by title-casing each segment (e.g., "plate-reader-abc" → "Plate Reader Abc").
  it("POST /api/v1/instruments derives display_name from kebab-case id", async () => {
    const res = await api("/api/v1/instruments", {
      method: "POST",
      token,
      body: { id: "plate-reader-abc" },
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.display_name).toBe("Plate Reader Abc");
  });

  it("POST /api/v1/instruments returns 409 for duplicate id", async () => {
    const res = await api("/api/v1/instruments", {
      method: "POST",
      token,
      body: { id: "test-instrument" },
    });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error.code).toBe("CONFLICT");
  });

  // Instrument IDs must be kebab-case because they're used as the first
  // segment of S3 keys (e.g., {instrument_id}/{run_id}/{filename}).
  it("POST /api/v1/instruments rejects invalid kebab-case", async () => {
    const res = await api("/api/v1/instruments", {
      method: "POST",
      token,
      body: { id: "Not Kebab Case" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("POST /api/v1/instruments rejects missing id", async () => {
    const res = await api("/api/v1/instruments", {
      method: "POST",
      token,
      body: {},
    });
    expect(res.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/instruments
  // -------------------------------------------------------------------------

  it("GET /api/v1/instruments lists all instruments", async () => {
    const res = await api("/api/v1/instruments", { token });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(2);
    expect(
      data.find((i: { id: string }) => i.id === "test-instrument")
    ).toBeTruthy();
    instrumentListItem.array().parse(data);
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/instruments/:instrumentId
  // -------------------------------------------------------------------------

  it("GET /api/v1/instruments/:id returns instrument detail with counts", async () => {
    const res = await api("/api/v1/instruments/test-instrument", { token });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe("test-instrument");
    expect(data.display_name).toBe("Test Instrument");
    expect(data).toHaveProperty("run_count");
    expect(data).toHaveProperty("watcher_count");
    instrumentDetail.parse(data);
  });

  it("GET /api/v1/instruments/:id returns 404 for nonexistent id", async () => {
    const res = await api("/api/v1/instruments/nonexistent-instrument", {
      token,
    });
    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // PATCH /api/v1/instruments/:instrumentId
  // -------------------------------------------------------------------------

  it("PATCH /api/v1/instruments/:id updates status", async () => {
    const res = await api("/api/v1/instruments/test-instrument", {
      method: "PATCH",
      token,
      body: { status: "active" },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("active");
    instrumentRecord.parse(data);
  });

  it("PATCH /api/v1/instruments/:id updates display_name", async () => {
    const res = await api("/api/v1/instruments/test-instrument", {
      method: "PATCH",
      token,
      body: {
        display_name: "Renamed Instrument",
      },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.display_name).toBe("Renamed Instrument");
  });

  it("PATCH /api/v1/instruments/:id rejects unknown fields", async () => {
    const res = await api("/api/v1/instruments/test-instrument", {
      method: "PATCH",
      token,
      body: { unknown_field: "value" },
    });
    expect(res.status).toBe(400);
  });

  it("PATCH /api/v1/instruments/:id rejects invalid status", async () => {
    const res = await api("/api/v1/instruments/test-instrument", {
      method: "PATCH",
      token,
      body: { status: "bogus" },
    });
    expect(res.status).toBe(400);
  });

  it("PATCH /api/v1/instruments/:id returns 404 for nonexistent id", async () => {
    const res = await api("/api/v1/instruments/nonexistent", {
      method: "PATCH",
      token,
      body: { status: "active" },
    });
    expect(res.status).toBe(404);
  });
});

// An instrument has at most one active watcher. Every instrument response says
// what that watcher is, how the instrument is connected, and how many past
// watchers it has had; the older count fields keep their values.
describe("Instruments API: watcher and connection", () => {
  let token: string;

  const MINUTE = 60 * 1000;
  const DAY = 24 * 60 * MINUTE;
  const CONFIG_YAML = [
    "instrument:",
    "  watch_directory: D:\\Exports\\Plate",
    "  file_patterns:",
    '    - "*.zz"',
    '    - "*.aa"',
    '    - "*.zz"',
    "  upload_mode: manual",
    "",
  ].join("\n");

  interface SeedWatcher {
    ageMs?: number | null;
    configYaml?: string | null;
    deregistered?: boolean;
    hostname?: string;
    reason?: string | null;
    status?: "registered" | "watching" | "stopped" | "waiting";
  }

  // Seeds an instrument with the given watchers, and returns their IDs in order.
  async function seed(
    id: string,
    watcherRows: SeedWatcher[],
    status: "active" | "pending" | "inactive" = "active"
  ): Promise<string[]> {
    const db = getTestDb();
    await db
      .insert(instruments)
      .values({ id, displayName: `Display ${id}`, status });
    const ids: string[] = [];
    for (const [index, w] of watcherRows.entries()) {
      const ageMs = w.ageMs === undefined ? 30_000 : w.ageMs;
      const [row] = await db
        .insert(watchers)
        .values({
          instrumentId: id,
          hostname: w.hostname ?? `host-${id}`,
          status: w.status ?? "watching",
          statusReason: w.reason ?? null,
          lastHeartbeatAt: ageMs === null ? null : new Date(Date.now() - ageMs),
          configYaml: w.configYaml === undefined ? CONFIG_YAML : w.configYaml,
          // Deregistered rows are older than the live one, newest last.
          createdAt: new Date(Date.now() - 30 * DAY + index * 1000),
          deletedAt: w.deregistered ? new Date(Date.now() - DAY + index) : null,
        })
        .returning({ id: watchers.id });
      ids.push(row.id);
    }
    return ids;
  }

  async function restDetail(id: string) {
    const res = await api(`/api/v1/instruments/${id}`, { token });
    expect(res.status).toBe(200);
    const data = await res.json();
    // Drift guard: a live response must match its documented schema.
    instrumentDetail.parse(data);
    return data;
  }

  beforeAll(async () => {
    await resetDb();
    ({ token } = await seedTestUser());
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("reports no watcher, offline, for an instrument that never had one", async () => {
    await seed("never-had-watcher", []);
    const data = await restDetail("never-had-watcher");
    expect(data.watcher).toBeNull();
    expect(data.connection).toEqual({ state: "offline", reason: "no_watcher" });
    expect(data.past_watcher_count).toBe(0);
    expect(data.watcher_count).toBe(0);
  });

  it("returns the one active watcher with its folder, patterns and mode", async () => {
    const [watcherId] = await seed("one-active-watcher", [
      { hostname: "Lab-PC-One" },
    ]);
    const data = await restDetail("one-active-watcher");
    expect(data.watcher).toMatchObject({
      id: watcherId,
      hostname: "Lab-PC-One",
      status: "watching",
      status_reason: null,
      watch_directory: "D:\\Exports\\Plate",
      // The config's order, with no clean-up.
      file_patterns: ["*.zz", "*.aa", "*.zz"],
      upload_mode: "manual",
      config_state: "none",
      shared_computer_with: [],
    });
    expect(data.watcher.last_heartbeat_at).toEqual(expect.any(String));
    expect(data.connection).toEqual({ state: "online", reason: null });
    expect(data.past_watcher_count).toBe(0);
    expect(data.watcher_count).toBe(1);
  });

  it("counts deregistered watchers but never returns one as the watcher", async () => {
    const [past1, past2, current] = await seed("current-and-past", [
      { deregistered: true, status: "stopped" },
      { deregistered: true, status: "stopped" },
      {},
    ]);
    const data = await restDetail("current-and-past");
    expect(data.watcher.id).toBe(current);
    expect(data.past_watcher_count).toBe(2);
    expect(data.watcher_count).toBe(1);

    // The deprecated fields still name the same watcher, and keep their
    // values: the file patterns stay sorted and de-duplicated.
    const detail = await getInstrumentById("current-and-past");
    expect(detail).toMatchObject({
      watcherCount: 1,
      watchersOnline: 1,
      watchersOffline: 0,
      activeWatcherId: current,
      activeWatcherHostname: "host-current-and-past",
      activeWatcherWatchDirectory: "D:\\Exports\\Plate",
      activeWatcherDeregistered: false,
      filePatterns: ["*.aa", "*.zz"],
    });
    expect([past1, past2]).not.toContain(detail?.activeWatcherId);
  });

  it("reports an instrument whose only watcher was deregistered as deregistered", async () => {
    const [past] = await seed("only-past-watcher", [
      { deregistered: true, status: "stopped", hostname: "retired-pc" },
    ]);
    const data = await restDetail("only-past-watcher");
    expect(data.watcher).toBeNull();
    expect(data.connection).toEqual({
      state: "offline",
      reason: "deregistered",
    });
    expect(data.past_watcher_count).toBe(1);
    expect(data.watcher_count).toBe(0);

    // The deprecated fields keep their values: the link still names the
    // deregistered watcher, but nothing is counted or watched.
    const detail = await getInstrumentById("only-past-watcher");
    expect(detail).toMatchObject({
      watcherCount: 0,
      watchersOnline: 0,
      watchersOffline: 0,
      lastWatcherHeartbeatAt: null,
      activeWatcherId: past,
      activeWatcherHostname: "retired-pc",
      activeWatcherWatchDirectory: null,
      activeWatcherDeregistered: true,
      filePatterns: [],
    });
  });

  // One row per state of the connection, from the stored watcher columns.
  const CONNECTION_CASES: {
    expected: { reason: string | null; state: string };
    id: string;
    name: string;
    watcher: SeedWatcher;
  }[] = [
    {
      id: "conn-online",
      name: "a watcher with a recent heartbeat is online",
      watcher: { status: "watching", ageMs: 30_000 },
      expected: { state: "online", reason: null },
    },
    {
      id: "conn-connecting",
      name: "a watcher with no heartbeat yet is connecting",
      watcher: { status: "registered", ageMs: null },
      expected: { state: "connecting", reason: null },
    },
    {
      id: "conn-update-1m",
      name: "a watcher stopped for an automatic update a minute ago is restarting",
      watcher: { status: "stopped", reason: "auto_update", ageMs: MINUTE },
      expected: { state: "restarting", reason: null },
    },
    {
      id: "conn-shutdown-10m",
      name: "a watcher stopped for a Windows restart 10 minutes ago is restarting",
      watcher: {
        status: "stopped",
        reason: "system_shutdown",
        ageMs: 10 * MINUTE,
      },
      expected: { state: "restarting", reason: null },
    },
    {
      id: "conn-update-16m",
      name: "a watcher stopped for an automatic update 16 minutes ago is unresponsive",
      watcher: { status: "stopped", reason: "auto_update", ageMs: 16 * MINUTE },
      expected: { state: "offline", reason: "unresponsive" },
    },
    {
      id: "conn-silent-6m",
      name: "a watcher silent for 6 minutes is unresponsive",
      watcher: { status: "watching", ageMs: 6 * MINUTE },
      expected: { state: "offline", reason: "unresponsive" },
    },
    {
      id: "conn-stopped-3d",
      name: "a watcher stopped by someone stays stopped, however long ago",
      watcher: { status: "stopped", ageMs: 3 * DAY },
      expected: { state: "offline", reason: "stopped" },
    },
    {
      id: "conn-waiting",
      name: "a watcher that can't find its folder is offline for that reason",
      watcher: { status: "waiting", reason: "D:\\Missing", ageMs: MINUTE },
      expected: { state: "offline", reason: "folder_missing" },
    },
  ];

  it.each(CONNECTION_CASES)("connection: $name", async ({
    id,
    watcher,
    expected,
  }) => {
    await seed(id, [watcher]);
    const data = await restDetail(id);
    expect(data.connection).toEqual(expected);
    // The deprecated counts follow the connection: only online counts.
    const detail = await getInstrumentById(id);
    expect(detail?.watchersOnline).toBe(expected.state === "online" ? 1 : 0);
    expect(detail?.watchersOffline).toBe(expected.state === "online" ? 0 : 1);
  });

  it("reports the connection of a pending instrument, and leaves its badge to the status", async () => {
    await seed(
      "pending-with-watcher",
      [{ status: "registered", ageMs: null }],
      "pending"
    );
    const data = await restDetail("pending-with-watcher");
    expect(data.status).toBe("pending");
    expect(data.connection).toEqual({ state: "connecting", reason: null });
  });

  it("lists the other instruments on the same computer, ignoring case and deregistered watchers", async () => {
    await seed("shared-pc-a", [{ hostname: "SHARED-LAB-PC" }]);
    await seed("shared-pc-b", [{ hostname: "shared-lab-pc" }]);
    await seed("shared-pc-gone", [
      { hostname: "Shared-Lab-Pc", deregistered: true, status: "stopped" },
    ]);
    await seed("shared-pc-none", [{ hostname: "another-lab-pc" }]);

    const a = await restDetail("shared-pc-a");
    expect(a.watcher.shared_computer_with).toEqual([
      { instrument_id: "shared-pc-b", display_name: "Display shared-pc-b" },
    ]);
    const b = await restDetail("shared-pc-b");
    expect(b.watcher.shared_computer_with).toEqual([
      { instrument_id: "shared-pc-a", display_name: "Display shared-pc-a" },
    ]);
    expect(
      (await restDetail("shared-pc-none")).watcher.shared_computer_with
    ).toEqual([]);
    // A deregistered watcher has no `watcher` object, so it lists nothing.
    expect((await restDetail("shared-pc-gone")).watcher).toBeNull();
  });

  it("reports the state of the watcher's settings", async () => {
    const [pending] = await seed("config-pending", [{}]);
    const [rejected] = await seed("config-rejected", [{}]);
    const [edited] = await seed("config-edited-on-pc", [{}]);
    const [applied] = await seed("config-applied", [{}]);
    await seed("config-none", [{}]);
    const settings = {
      watch_directory: "D:\\Exports\\Plate",
      file_patterns: ["*.zz"],
      run_detection: { pattern: "^(.*)$", recursive: true },
      upload_mode: "manual",
      stability_period_seconds: 5,
      max_stability_wait_seconds: 300,
      upload_parallelism: 4,
    };
    const db = getTestDb();
    await db.insert(watcherConfigRevisions).values([
      // A change waiting for the watcher.
      {
        watcherId: pending,
        revision: 1,
        source: "web",
        settings,
        status: "pending",
      },
      // A change the watcher refused.
      {
        watcherId: rejected,
        revision: 1,
        source: "web",
        settings,
        status: "rejected",
        statusReason: "The folder does not exist.",
      },
      // An edit made on the PC while the watcher ran.
      {
        watcherId: edited,
        revision: 1,
        source: "pc",
        settings,
        status: "applied",
      },
      // A change the watcher applied.
      {
        watcherId: applied,
        revision: 1,
        source: "web",
        settings,
        status: "applied",
      },
    ]);
    // The running watcher reports revision 0, so the PC edit awaits a restart.
    await db
      .update(watchers)
      .set({ appliedConfigRevision: 0 })
      .where(eq(watchers.id, edited));
    await db
      .update(watchers)
      .set({ appliedConfigRevision: 1 })
      .where(eq(watchers.id, applied));

    const stateOf = async (id: string) =>
      (await restDetail(id)).watcher.config_state;
    expect(await stateOf("config-pending")).toBe("pending");
    expect(await stateOf("config-rejected")).toBe("rejected");
    expect(await stateOf("config-edited-on-pc")).toBe("edited_on_pc");
    expect(await stateOf("config-applied")).toBe("applied");
    expect(await stateOf("config-none")).toBe("none");
  });

  it("lists every instrument with its watcher, connection and past watcher count", async () => {
    const res = await api("/api/v1/instruments", { token });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      connection: unknown;
      id: string;
      past_watcher_count: number;
      watcher: { id: string } | null;
    }[];
    instrumentListItem.array().parse(data);

    const byId = new Map(data.map((row) => [row.id, row]));
    expect(byId.get("never-had-watcher")).toMatchObject({
      watcher: null,
      connection: { state: "offline", reason: "no_watcher" },
      past_watcher_count: 0,
    });
    expect(byId.get("only-past-watcher")).toMatchObject({
      watcher: null,
      connection: { state: "offline", reason: "deregistered" },
      past_watcher_count: 1,
    });
    expect(byId.get("current-and-past")).toMatchObject({
      connection: { state: "online", reason: null },
      past_watcher_count: 2,
    });
    expect(byId.get("current-and-past")?.watcher).not.toBeNull();
    expect(byId.get("shared-pc-a")?.watcher).toMatchObject({
      shared_computer_with: [{ instrument_id: "shared-pc-b" }],
    });
  });

  it("agrees with the server function the web app renders from", async () => {
    for (const id of [
      "one-active-watcher",
      "only-past-watcher",
      "never-had-watcher",
    ]) {
      const rest = await restDetail(id);
      const web = await getInstrumentById(id);
      expect(rest.connection).toEqual(web?.connection);
      expect(rest.past_watcher_count).toBe(web?.pastWatcherCount);
      expect(rest.watcher?.id ?? null).toBe(web?.watcher?.id ?? null);
      expect(rest.watcher?.file_patterns ?? null).toEqual(
        web?.watcher?.filePatterns ?? null
      );
    }
  });
});
