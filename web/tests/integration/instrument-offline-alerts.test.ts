import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { runInstrumentOfflineAlerts } from "@/lib/api/instrument-offline-alerts";
import {
  getPreferences,
  listNotifications,
  setInstrumentSubscription,
  updatePreferences,
} from "@/lib/api/notifications";
import {
  instrumentOfflineAlerts,
  instruments,
  notifications,
  slackConnections,
  watchers,
} from "@/lib/db/schema";
import { upsertSlackConnection } from "@/lib/slack/connections";
import {
  api,
  clearCapturedSlackDms,
  closeTestDb,
  getCapturedSlackDms,
  getTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";

// The offline-alert job end to end against the test database: it reads every
// instrument's badge, moves `instrument_offline_alerts`, and writes bell rows
// and Slack DMs. The job runs in this process with a pinned clock, since the
// test server's clock can't be moved. The route itself is checked once for its
// cron secret.

// Must match CRON_SECRET set on the test server in global-setup.ts.
const CRON_SECRET = "test-cron-secret";
const ORIGIN = "https://datahub.test";
const MINUTE = 60 * 1000;
const T0 = new Date("2026-11-17T12:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * MINUTE);

const INSTRUMENT_ID = "offline-alert-reader";
const DISPLAY_NAME = "Offline Alert Reader";

async function seedInstrument(
  instrumentId = INSTRUMENT_ID,
  displayName = DISPLAY_NAME
): Promise<void> {
  await getTestDb()
    .insert(instruments)
    .values({ id: instrumentId, displayName, status: "active" });
}

type WatcherState = Pick<
  typeof watchers.$inferInsert,
  "status" | "statusReason" | "lastHeartbeatAt"
>;

async function seedWatcher(
  state: WatcherState,
  instrumentId = INSTRUMENT_ID
): Promise<void> {
  await getTestDb()
    .insert(watchers)
    .values({
      instrumentId,
      hostname: "LAB-PC-1",
      configYaml: "instrument:\n  watch_directory: D:\\Exports\n",
      ...state,
    });
}

async function setWatcher(
  state: WatcherState,
  instrumentId = INSTRUMENT_ID
): Promise<void> {
  await getTestDb()
    .update(watchers)
    .set(state)
    .where(eq(watchers.instrumentId, instrumentId));
}

const folderMissing = (heartbeat: Date): WatcherState => ({
  status: "waiting",
  statusReason: "watch_directory not found: D:\\Exports",
  lastHeartbeatAt: heartbeat,
});
const watching = (heartbeat: Date): WatcherState => ({
  status: "watching",
  statusReason: null,
  lastHeartbeatAt: heartbeat,
});

function run(now: Date) {
  return runInstrumentOfflineAlerts({ now, origin: ORIGIN });
}

async function alertRow(instrumentId = INSTRUMENT_ID) {
  const [row] = await getTestDb()
    .select()
    .from(instrumentOfflineAlerts)
    .where(eq(instrumentOfflineAlerts.instrumentId, instrumentId));
  return row ?? null;
}

function rowsOfType(type: "instrument_offline" | "instrument_back_online") {
  return getTestDb()
    .select()
    .from(notifications)
    .where(eq(notifications.type, type));
}

async function subscribe(options?: Parameters<typeof seedTestUser>[0]) {
  const { userId } = await seedTestUser(options);
  await setInstrumentSubscription(userId, INSTRUMENT_ID, true);
  return userId;
}

// Takes the instrument through its first sighting at T0 and the alert at
// T0 + 30 minutes, with the folder missing throughout.
async function alertAtThirtyMinutes(): Promise<void> {
  await seedWatcher(folderMissing(at(-1)));
  await run(T0);
  await setWatcher(folderMissing(at(29)));
  const summary = await run(at(30));
  expect(summary.alerted).toBe(1);
}

describe("Instrument offline alerts", () => {
  beforeEach(async () => {
    await resetDb();
    await clearCapturedSlackDms();
    await seedInstrument();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("starts a clock the first time it sees the badge Offline, and sends nothing", async () => {
    await subscribe();
    await seedWatcher(folderMissing(at(-1)));

    const summary = await run(T0);

    expect(summary).toMatchObject({ paused: false, started: 1, alerted: 0 });
    expect(await alertRow()).toMatchObject({
      offlineSince: T0,
      alertedAt: null,
    });
    expect(await rowsOfType("instrument_offline")).toHaveLength(0);
  });

  it("alerts subscribers after 30 minutes, by their own toggles", async () => {
    const withSlack = await subscribe();
    await upsertSlackConnection(withSlack, {
      slackUserId: "U_OFFLINE_ALERT",
      slackTeamId: "T_TEST",
      slackTeamName: "Test Workspace",
    });
    const inAppOff = await subscribe();
    await updatePreferences(inAppOff, { instrumentOfflineEnabled: false });
    const mutedNewRuns = await subscribe();
    await updatePreferences(mutedNewRuns, { runsAllMuted: true });
    const { userId: unsubscribed } = await seedTestUser();
    await setInstrumentSubscription(unsubscribed, INSTRUMENT_ID, false);
    await seedTestUser();

    await alertAtThirtyMinutes();

    const rows = await rowsOfType("instrument_offline");
    expect(rows.map((row) => row.userId).sort()).toEqual(
      [withSlack, mutedNewRuns].sort()
    );
    expect(rows[0]).toMatchObject({
      instrumentId: INSTRUMENT_ID,
      runId: null,
      body: "The watcher can't find D:\\Exports, so it isn't picking up new files from this instrument.",
    });
    expect((await alertRow())?.alertedAt).toEqual(at(30));

    const dms = await getCapturedSlackDms();
    expect(dms).toHaveLength(1);
    expect(dms[0].channel).toBe("U_OFFLINE_ALERT");
    expect(dms[0].text).toContain(`${DISPLAY_NAME} is offline: The watcher`);
    expect(JSON.stringify(dms[0].blocks)).toContain(
      `${ORIGIN}/instruments/${INSTRUMENT_ID}|View in Data Hub`
    );

    const [feedRow] = await listNotifications(withSlack);
    expect(feedRow).toMatchObject({
      type: "instrument_offline",
      instrumentId: INSTRUMENT_ID,
      instrumentDisplayName: DISPLAY_NAME,
      runId: null,
    });
  });

  it("waits until the badge has been Offline for 30 minutes", async () => {
    await subscribe();
    await seedWatcher(folderMissing(at(-1)));
    await run(T0);
    await setWatcher(folderMissing(at(25)));

    expect((await run(at(25))).alerted).toBe(0);
    // A run that starts up to a minute early still alerts.
    expect((await run(at(29))).alerted).toBe(1);
  });

  it("sends one alert per outage, even when the reason changes", async () => {
    await subscribe();
    await alertAtThirtyMinutes();

    // The watcher dies: the reason turns from folder missing to unresponsive.
    const summary = await run(at(60));

    expect(summary.alerted).toBe(0);
    expect(await rowsOfType("instrument_offline")).toHaveLength(1);
  });

  it("says back online, and how long it was offline, when the badge is Online", async () => {
    const userId = await subscribe();
    await alertAtThirtyMinutes();
    await setWatcher(watching(at(74)));

    const summary = await run(at(75));

    expect(summary.recovered).toBe(1);
    const [row] = await rowsOfType("instrument_back_online");
    expect(row).toMatchObject({
      userId,
      instrumentId: INSTRUMENT_ID,
      body: "It was offline for about 1 hour.",
    });
    expect(await alertRow()).toBeNull();
  });

  it("clears the clock without a word if the badge recovers within 30 minutes", async () => {
    await subscribe();
    await seedWatcher(folderMissing(at(-1)));
    await run(T0);
    await setWatcher(watching(at(9)));

    const summary = await run(at(10));

    expect(summary.cleared).toBe(1);
    expect(await alertRow()).toBeNull();
    expect(await rowsOfType("instrument_offline")).toHaveLength(0);
  });

  it("waits through a restart after the alert, then says back online", async () => {
    await subscribe();
    await alertAtThirtyMinutes();
    await setWatcher({
      status: "stopped",
      statusReason: "system_shutdown",
      lastHeartbeatAt: at(40),
    });

    expect(await run(at(45))).toMatchObject({ recovered: 0, cleared: 0 });

    await setWatcher(watching(at(49)));
    expect((await run(at(50))).recovered).toBe(1);
  });

  it("ends the outage silently when the instrument is retired", async () => {
    await subscribe();
    await alertAtThirtyMinutes();
    await getTestDb()
      .update(instruments)
      .set({ status: "inactive" })
      .where(eq(instruments.id, INSTRUMENT_ID));

    const summary = await run(at(40));

    expect(summary).toMatchObject({ cleared: 1, recovered: 0 });
    expect(await alertRow()).toBeNull();
    expect(await rowsOfType("instrument_back_online")).toHaveLength(0);
  });

  it("alerts once when two runs reach the same outage at the same moment", async () => {
    const userId = await subscribe();
    await upsertSlackConnection(userId, {
      slackUserId: "U_OFFLINE_ONCE",
      slackTeamId: "T_TEST",
      slackTeamName: "Test Workspace",
    });
    await seedWatcher(folderMissing(at(29)));
    await getTestDb()
      .insert(instrumentOfflineAlerts)
      .values({ instrumentId: INSTRUMENT_ID, offlineSince: T0 });

    const summaries = await Promise.all([run(at(30)), run(at(30))]);

    expect(summaries.map((summary) => summary.alerted).sort()).toEqual([0, 1]);
    expect(await rowsOfType("instrument_offline")).toHaveLength(1);
    expect(await getCapturedSlackDms()).toHaveLength(1);
  });

  it("holds back unresponsive alerts while no watcher checks in, and nothing else", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await subscribe();
    await seedInstrument("offline-alert-second", "Second Reader");
    await seedInstrument("offline-alert-stopped", "Stopped Reader");
    // Both watchers that should check in went quiet 10 minutes ago.
    await seedWatcher(watching(at(-10)));
    await seedWatcher(watching(at(-10)), "offline-alert-second");
    // Someone stopped this one: a reason that doesn't depend on heartbeats.
    await seedWatcher(
      { status: "stopped", statusReason: null, lastHeartbeatAt: at(-10) },
      "offline-alert-stopped"
    );
    // The first instrument's clock started before the pause.
    await getTestDb()
      .insert(instrumentOfflineAlerts)
      .values({ instrumentId: INSTRUMENT_ID, offlineSince: at(-40) });

    const summary = await run(T0);

    expect(summary).toMatchObject({
      paused: true,
      alerted: 0,
      cleared: 1,
      started: 1,
    });
    expect(await alertRow()).toBeNull();
    expect(await alertRow("offline-alert-second")).toBeNull();
    expect(await alertRow("offline-alert-stopped")).toMatchObject({
      offlineSince: T0,
    });
    expect(await rowsOfType("instrument_offline")).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("explains a deregistered watcher, told apart from one that never existed", async () => {
    await subscribe();
    await seedWatcher({
      status: "watching",
      statusReason: null,
      lastHeartbeatAt: at(-60),
    });
    await getTestDb()
      .update(watchers)
      .set({ deletedAt: at(-30) })
      .where(eq(watchers.instrumentId, INSTRUMENT_ID));

    await run(T0);
    expect((await run(at(30))).alerted).toBe(1);

    const [row] = await rowsOfType("instrument_offline");
    expect(row.body).toBe(
      "Its watcher was deregistered. New files won't appear until a new watcher is set up."
    );
  });

  it("sends no Slack DM when the toggle is off or the connection is revoked", async () => {
    const toggleOff = await subscribe();
    await upsertSlackConnection(toggleOff, {
      slackUserId: "U_TOGGLE_OFF",
      slackTeamId: "T_TEST",
      slackTeamName: "Test Workspace",
    });
    await updatePreferences(toggleOff, {
      slackInstrumentOfflineEnabled: false,
    });
    const revoked = await subscribe();
    await upsertSlackConnection(revoked, {
      slackUserId: "U_REVOKED",
      slackTeamId: "T_TEST",
      slackTeamName: "Test Workspace",
    });
    await getTestDb()
      .update(slackConnections)
      .set({ revokedAt: at(-60) })
      .where(eq(slackConnections.userId, revoked));

    await alertAtThirtyMinutes();

    expect(
      (await rowsOfType("instrument_offline")).map((row) => row.userId).sort()
    ).toEqual([toggleOff, revoked].sort());
    expect(await getCapturedSlackDms()).toHaveLength(0);
  });

  it("says back online once when two runs see the recovery at the same moment", async () => {
    await subscribe();
    await alertAtThirtyMinutes();
    await setWatcher(watching(at(74)));

    const summaries = await Promise.all([run(at(75)), run(at(75))]);

    expect(summaries.map((summary) => summary.recovered).sort()).toEqual([
      0, 1,
    ]);
    expect(await rowsOfType("instrument_back_online")).toHaveLength(1);
    expect(await alertRow()).toBeNull();
  });

  it("turns the Slack toggle on when someone connects Slack", async () => {
    const { userId } = await seedTestUser();
    expect((await getPreferences(userId)).slackInstrumentOfflineEnabled).toBe(
      false
    );

    await upsertSlackConnection(userId, {
      slackUserId: "U_CONNECT",
      slackTeamId: "T_TEST",
      slackTeamName: "Test Workspace",
    });

    expect((await getPreferences(userId)).slackInstrumentOfflineEnabled).toBe(
      true
    );
  });

  it("runs from the cron route only with the cron secret", async () => {
    const path = "/api/cron/instrument-offline-alerts";
    expect((await api(path)).status).toBe(401);
    expect(
      (await api(path, { headers: { Authorization: "Bearer wrong" } })).status
    ).toBe(401);

    const res = await api(path, {
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      paused: false,
      failed_instruments: 0,
    });
  });
});
