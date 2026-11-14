import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getWatcherHealth } from "@/lib/api/watcher-health";
import { instruments, watcherEvents, watchers } from "@/lib/db/schema";
import { restartReasonOf } from "@/lib/watchers/stop-reasons";
import {
  api,
  closeTestDb,
  getTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";

// A watcher that installs an update through the Windows upgrade worker is
// stopped from outside, so its `watcher_stopped` event says only "Service
// stopped". The reason is in the final `stopped` heartbeat (`status_reason`),
// and the server copies it onto the event as `details.stop_reason`, whichever
// of the two arrives first. Health and Activity read it from there.

const MINUTE_MS = 60 * 1000;

describe("The reason a watcher stopped, copied onto its stop event", () => {
  let token: string;
  let counter = 0;

  beforeAll(async () => {
    await resetDb();
    ({ token } = await seedTestUser());
    await getTestDb().insert(instruments).values({
      id: "stop-reason-inst",
      displayName: "Stop Reason Instrument",
      status: "active",
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  // One active watcher per instrument is enforced by a unique index, so each
  // test's watcher replaces the previous one.
  async function newWatcher(): Promise<string> {
    counter += 1;
    await getTestDb()
      .update(watchers)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(watchers.instrumentId, "stop-reason-inst"),
          isNull(watchers.deletedAt)
        )
      );
    const [watcher] = await getTestDb()
      .insert(watchers)
      .values({
        instrumentId: "stop-reason-inst",
        hostname: `STOP-PC-${counter}`,
        status: "watching",
        lastHeartbeatAt: new Date(),
      })
      .returning({ id: watchers.id });
    return watcher.id;
  }

  function postStopEvent(
    watcherId: string,
    timestamp: Date,
    details?: Record<string, unknown>
  ) {
    return api(`/api/v1/watchers/${watcherId}/events`, {
      method: "POST",
      token,
      body: {
        events: [
          {
            event_type: "watcher_stopped",
            message: "Service stopped",
            timestamp: timestamp.toISOString(),
            ...(details ? { details } : {}),
          },
        ],
      },
    });
  }

  function postStoppedHeartbeat(
    watcherId: string,
    timestamp: Date,
    statusReason?: string
  ) {
    return api(`/api/v1/watchers/${watcherId}/heartbeat`, {
      method: "POST",
      token,
      body: {
        status: "stopped",
        timestamp: timestamp.toISOString(),
        ...(statusReason ? { status_reason: statusReason } : {}),
      },
    });
  }

  async function stopEvents(watcherId: string) {
    return await getTestDb()
      .select()
      .from(watcherEvents)
      .where(
        and(
          eq(watcherEvents.watcherId, watcherId),
          eq(watcherEvents.eventType, "watcher_stopped")
        )
      );
  }

  it("stamps the stop event when the event arrives first and the heartbeat after it", async () => {
    const watcherId = await newWatcher();
    const stoppedAt = new Date();
    expect((await postStopEvent(watcherId, stoppedAt)).status).toBe(201);
    expect(
      (await postStoppedHeartbeat(watcherId, stoppedAt, "auto_update")).status
    ).toBe(200);

    const events = await stopEvents(watcherId);
    expect(events).toHaveLength(1);
    expect(events[0].details).toEqual({ stop_reason: "auto_update" });
    expect(restartReasonOf(events[0])).toBe("update");
  });

  it("stamps the stop event when the heartbeat arrives first and the event after it", async () => {
    const watcherId = await newWatcher();
    const stoppedAt = new Date();
    expect(
      (await postStoppedHeartbeat(watcherId, stoppedAt, "system_shutdown"))
        .status
    ).toBe(200);
    // Nothing to stamp yet.
    expect(await stopEvents(watcherId)).toHaveLength(0);
    expect((await postStopEvent(watcherId, stoppedAt)).status).toBe(201);

    const events = await stopEvents(watcherId);
    expect(events).toHaveLength(1);
    expect(events[0].details).toEqual({ stop_reason: "system_shutdown" });
    expect(restartReasonOf(events[0])).toBe("windows");
  });

  it("never overwrites a reason the event already has", async () => {
    const watcherId = await newWatcher();
    const stoppedAt = new Date();
    await postStopEvent(watcherId, stoppedAt, {
      stop_reason: "system_shutdown",
    });
    await postStoppedHeartbeat(watcherId, stoppedAt, "auto_update");

    const events = await stopEvents(watcherId);
    expect(events[0].details).toEqual({ stop_reason: "system_shutdown" });
  });

  it("leaves a stop alone when the heartbeat gives no restart reason", async () => {
    const watcherId = await newWatcher();
    const stoppedAt = new Date();
    await postStopEvent(watcherId, stoppedAt);
    await postStoppedHeartbeat(watcherId, stoppedAt);

    const events = await stopEvents(watcherId);
    // The heartbeat reverts no queue here, so the server's own note isn't added
    // either way: the only stop is the watcher's own, and it has no reason.
    const own = events.filter(
      (event) =>
        (event.details as { kind?: string } | null)?.kind !==
        "upload_requests_cancelled"
    );
    expect(own).toHaveLength(1);
    expect(own[0].details).toBeNull();
    expect(restartReasonOf(own[0])).toBeNull();
  });

  it("does not stamp a stop from long before the heartbeat", async () => {
    const watcherId = await newWatcher();
    const stoppedAt = new Date();
    await postStopEvent(
      watcherId,
      new Date(stoppedAt.getTime() - 60 * MINUTE_MS)
    );
    await postStoppedHeartbeat(watcherId, stoppedAt, "auto_update");

    const events = await stopEvents(watcherId);
    expect(events[0].details).toBeNull();
  });

  it("makes Health count the restart", async () => {
    const watcherId = await newWatcher();
    const stoppedAt = new Date(Date.now() - 20 * MINUTE_MS);
    await postStopEvent(watcherId, stoppedAt);
    await postStoppedHeartbeat(watcherId, stoppedAt, "auto_update");

    const day = stoppedAt.toISOString().slice(0, 10);
    const health = await getWatcherHealth(watcherId, {
      fromDay: day,
      toDay: day,
      start: new Date(`${day}T00:00:00.000Z`),
      endExclusive: new Date(
        new Date(`${day}T00:00:00.000Z`).getTime() + 24 * 60 * MINUTE_MS
      ),
      timeZone: "UTC",
      deregisteredAt: null,
    });
    expect(health.totals.restarts).toEqual({ update: 1, windows: 0 });
  });
});
