import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  computeEffectiveStatus,
  type EffectiveStatus,
  effectiveStatusCondition,
} from "@/lib/api/watchers";
import { instruments, watchers } from "@/lib/db/schema";
import { closeTestDb, getTestDb, resetDb } from "@/tests/integration/helpers";

// `@/lib/api/watchers` loads the app's database client, which needs
// DATABASE_URL. The queries below run on the test database through
// `getTestDb()`, so the client is replaced.
vi.mock("@/lib/db", () => ({ db: {} }));

// `computeEffectiveStatus` (JavaScript) and `effectiveStatusCondition` (SQL)
// are two copies of one rule. This file runs both on rows placed exactly at the
// 5-minute and 15-minute limits, and a millisecond either side, with one fixed
// clock. They must agree, and each row must satisfy exactly one status.

const NOW = new Date("2026-06-01T12:00:00.000Z");
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

const ALL_STATUSES: EffectiveStatus[] = [
  "registered",
  "watching",
  "stopped",
  "waiting",
  "stale",
];

type StoredStatus = "registered" | "watching" | "stopped" | "waiting";

const STORED: { status: StoredStatus; reason: string | null }[] = [
  { status: "registered", reason: null },
  { status: "watching", reason: null },
  { status: "waiting", reason: "watch_directory not found: /data" },
  { status: "stopped", reason: null },
  { status: "stopped", reason: "system_shutdown" },
  { status: "stopped", reason: "auto_update" },
  { status: "stopped", reason: "shutdown" },
];

// How old the last heartbeat is. A millisecond before, on, and past each limit,
// plus a fresh one, a day-old one, and none at all.
const AGES: (number | null)[] = [
  0,
  5 * MINUTE_MS - 1,
  5 * MINUTE_MS,
  5 * MINUTE_MS + 1,
  15 * MINUTE_MS - 1,
  15 * MINUTE_MS,
  15 * MINUTE_MS + 1,
  DAY_MS,
  null,
];

interface Fixture {
  ageMs: number | null;
  deregistered: boolean;
  key: string;
  reason: string | null;
  status: StoredStatus;
}

function keyOf(
  status: string,
  reason: string | null,
  ageMs: number | null,
  deregistered: boolean
): string {
  return `${deregistered ? "deregistered " : ""}${status} (${reason ?? "no reason"}), ${ageMs === null ? "no heartbeat" : `${ageMs} ms old`}`;
}

const FIXTURES: Fixture[] = [false, true].flatMap((deregistered) =>
  STORED.flatMap(({ status, reason }) =>
    AGES.map((ageMs) => ({
      status,
      reason,
      ageMs,
      deregistered,
      key: keyOf(status, reason, ageMs, deregistered),
    }))
  )
);

describe("effectiveStatusCondition and computeEffectiveStatus at their limits", () => {
  const idByKey = new Map<string, string>();
  const keyById = new Map<string, string>();
  // The statuses each row satisfies in SQL, by key.
  const sqlStatuses = new Map<string, EffectiveStatus[]>();
  const jsStatus = new Map<string, EffectiveStatus>();

  beforeAll(async () => {
    await resetDb();
    const db = getTestDb();

    await db.insert(instruments).values(
      FIXTURES.map((_fixture, index) => ({
        id: `boundary-inst-${index}`,
        displayName: `Boundary instrument ${index}`,
        status: "active" as const,
      }))
    );
    const inserted = await db
      .insert(watchers)
      .values(
        FIXTURES.map((fixture, index) => ({
          instrumentId: `boundary-inst-${index}`,
          hostname: `boundary-pc-${index}`,
          status: fixture.status,
          statusReason: fixture.reason,
          lastHeartbeatAt:
            fixture.ageMs === null
              ? null
              : new Date(NOW.getTime() - fixture.ageMs),
          deletedAt: fixture.deregistered ? new Date(NOW.getTime() - 1) : null,
        }))
      )
      .returning({ id: watchers.id, instrumentId: watchers.instrumentId });
    for (const row of inserted) {
      const index = Number(row.instrumentId.replace("boundary-inst-", ""));
      idByKey.set(FIXTURES[index].key, row.id);
      keyById.set(row.id, FIXTURES[index].key);
    }

    // What the SQL condition says, status by status.
    for (const status of ALL_STATUSES) {
      const rows = await db
        .select({ id: watchers.id })
        .from(watchers)
        .where(effectiveStatusCondition(status, NOW));
      for (const { id } of rows) {
        const key = keyById.get(id) ?? id;
        sqlStatuses.set(key, [...(sqlStatuses.get(key) ?? []), status]);
      }
    }

    // What the JavaScript rule says, on the rows as the database returns them.
    const stored = await db
      .select({
        id: watchers.id,
        status: watchers.status,
        statusReason: watchers.statusReason,
        lastHeartbeatAt: watchers.lastHeartbeatAt,
        deletedAt: watchers.deletedAt,
      })
      .from(watchers);
    for (const row of stored) {
      jsStatus.set(
        keyById.get(row.id) ?? row.id,
        computeEffectiveStatus(row, NOW)
      );
    }
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("puts every row in the database under test", () => {
    expect(idByKey.size).toBe(FIXTURES.length);
    expect(jsStatus.size).toBe(FIXTURES.length);
  });

  it("satisfies exactly one status condition for each row", () => {
    const notOne = FIXTURES.filter(
      (fixture) => (sqlStatuses.get(fixture.key) ?? []).length !== 1
    ).map((fixture) => ({
      key: fixture.key,
      statuses: sqlStatuses.get(fixture.key) ?? [],
    }));
    expect(notOne).toEqual([]);
  });

  it("gives each row the status computeEffectiveStatus gives it", () => {
    const disagree = FIXTURES.filter(
      (fixture) =>
        (sqlStatuses.get(fixture.key) ?? [])[0] !== jsStatus.get(fixture.key)
    ).map((fixture) => ({
      key: fixture.key,
      sql: sqlStatuses.get(fixture.key),
      js: jsStatus.get(fixture.key),
    }));
    expect(disagree).toEqual([]);
  });

  // The two copies could drift the same way, so the limits are also written out.
  describe.each<
    [
      name: string,
      status: StoredStatus,
      reason: string | null,
      ageMs: number | null,
      deregistered: boolean,
      expected: EffectiveStatus,
    ]
  >([
    [
      "watching, a millisecond inside the limit",
      "watching",
      null,
      5 * MINUTE_MS - 1,
      false,
      "watching",
    ],
    [
      "watching, on the 5-minute limit",
      "watching",
      null,
      5 * MINUTE_MS,
      false,
      "watching",
    ],
    [
      "watching, a millisecond past it",
      "watching",
      null,
      5 * MINUTE_MS + 1,
      false,
      "stale",
    ],
    [
      "waiting, on the 5-minute limit",
      "waiting",
      "watch_directory not found: /data",
      5 * MINUTE_MS,
      false,
      "waiting",
    ],
    [
      "waiting, a millisecond past it",
      "waiting",
      "watch_directory not found: /data",
      5 * MINUTE_MS + 1,
      false,
      "stale",
    ],
    [
      "plain stop, a millisecond past 5 minutes",
      "stopped",
      null,
      5 * MINUTE_MS + 1,
      false,
      "stopped",
    ],
    [
      "plain stop, a millisecond past 15 minutes",
      "stopped",
      null,
      15 * MINUTE_MS + 1,
      false,
      "stopped",
    ],
    [
      "restart stop, a millisecond past 5 minutes",
      "stopped",
      "system_shutdown",
      5 * MINUTE_MS + 1,
      false,
      "stopped",
    ],
    [
      "restart stop, a millisecond inside 15 minutes",
      "stopped",
      "system_shutdown",
      15 * MINUTE_MS - 1,
      false,
      "stopped",
    ],
    [
      "restart stop, on the 15-minute limit",
      "stopped",
      "system_shutdown",
      15 * MINUTE_MS,
      false,
      "stopped",
    ],
    [
      "restart stop, a millisecond past it",
      "stopped",
      "system_shutdown",
      15 * MINUTE_MS + 1,
      false,
      "stale",
    ],
    [
      "update stop, on the 15-minute limit",
      "stopped",
      "auto_update",
      15 * MINUTE_MS,
      false,
      "stopped",
    ],
    [
      "update stop, a millisecond past it",
      "stopped",
      "auto_update",
      15 * MINUTE_MS + 1,
      false,
      "stale",
    ],
    [
      "restart stop, no heartbeat",
      "stopped",
      "system_shutdown",
      null,
      false,
      "stale",
    ],
    ["registered, a day old", "registered", null, DAY_MS, false, "registered"],
    [
      "deregistered, watching, past the limit",
      "watching",
      null,
      5 * MINUTE_MS + 1,
      true,
      "stopped",
    ],
    [
      "deregistered, restart stop, past the limit",
      "stopped",
      "system_shutdown",
      15 * MINUTE_MS + 1,
      true,
      "stopped",
    ],
  ])("%s", (_name, status, reason, ageMs, deregistered, expected) => {
    it(`reads ${expected} in SQL and in JavaScript`, () => {
      const key = keyOf(status, reason, ageMs, deregistered);
      expect(sqlStatuses.get(key)).toEqual([expected]);
      expect(jsStatus.get(key)).toBe(expected);
    });
  });
});
