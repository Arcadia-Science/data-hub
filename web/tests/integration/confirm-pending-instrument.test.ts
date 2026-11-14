import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { instrumentRecord } from "@/lib/api/openapi";
import {
  files,
  instrumentRuns,
  instruments,
  personalAccessTokens,
  watchers,
} from "@/lib/db/schema";
import {
  api,
  closeTestDb,
  getTestDb,
  resetDb,
  seedSessionCookie,
  seedTestUser,
} from "@/tests/integration/helpers";

describe("Confirming a pending instrument", () => {
  let adminCookie: string;
  let memberCookie: string;

  beforeAll(async () => {
    await resetDb();
    const admin = await seedTestUser({ isAdmin: true, name: "Admin" });
    adminCookie = await seedSessionCookie(admin.userId);
    const member = await seedTestUser({ isAdmin: false, name: "Member" });
    memberCookie = await seedSessionCookie(member.userId);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  async function seedPending(id: string) {
    await getTestDb().insert(instruments).values({
      id,
      displayName: "Plate Reader A",
      status: "pending",
      instrumentType: "generic",
    });
  }

  async function storedState(id: string) {
    const [row] = await getTestDb()
      .select({
        status: instruments.status,
        instrumentType: instruments.instrumentType,
      })
      .from(instruments)
      .where(eq(instruments.id, id));
    return row;
  }

  // The Confirm dialog sends one PATCH with both fields, so the status and the
  // type change in the same update.
  it("PATCH with status active and an instrument type sets both in one request", async () => {
    await seedPending("plate-reader-a");
    const res = await api("/api/v1/instruments/plate-reader-a", {
      method: "PATCH",
      headers: { Cookie: adminCookie },
      body: { status: "active", instrument_type: "plate_reader" },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    instrumentRecord.parse(data);
    expect(data).toMatchObject({
      id: "plate-reader-a",
      status: "active",
      instrument_type: "plate_reader",
    });
    expect(await storedState("plate-reader-a")).toEqual({
      status: "active",
      instrumentType: "plate_reader",
    });
  });

  it("refuses a member's session with 403 and leaves the instrument pending", async () => {
    await seedPending("plate-reader-b");
    const res = await api("/api/v1/instruments/plate-reader-b", {
      method: "PATCH",
      headers: { Cookie: memberCookie },
      body: { status: "active", instrument_type: "plate_reader" },
    });
    expect(res.status).toBe(403);
    expect(await storedState("plate-reader-b")).toEqual({
      status: "pending",
      instrumentType: "generic",
    });
  });

  describe("the review the dialog loads", () => {
    const PC_CONFIG = [
      "instrument:",
      "  watch_directory: 'D:\\Exports'",
      "  file_patterns:",
      "    - '*.csv'",
      "  run_detection:",
      "    pattern: '^([^_]+)'",
      "    recursive: false",
      "  upload_mode: manual",
    ].join("\n");

    async function seedWatcher(
      instrumentId: string,
      registeredByToken: string | null
    ) {
      await getTestDb().insert(watchers).values({
        instrumentId,
        hostname: "LAB-PC-01",
        registeredByToken,
        configYaml: PC_CONFIG,
      });
    }

    it("gives an admin the watcher's registration and settings", async () => {
      const pc = await seedTestUser({ tokenName: "Lab PC token" });
      await seedPending("plate-reader-c");
      await seedWatcher("plate-reader-c", pc.tokenId);

      const res = await api(
        "/api/v1/instruments/plate-reader-c/confirm-review",
        { headers: { Cookie: adminCookie } }
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        displayName: "Plate Reader A",
        instrumentId: "plate-reader-c",
        // No files yet, so the example uses the sample path.
        runExample: { path: "RUN001_quant.csv", runId: "RUN001" },
        watcher: {
          hostname: "LAB-PC-01",
          tokenName: "Lab PC token",
          tokenRevoked: false,
          filePatterns: ["*.csv"],
          runDetection: { pattern: "^([^_]+)" },
          uploadMode: "manual",
          watchDirectory: "D:\\Exports",
        },
      });
    });

    it("uses the newest raw file for the example, skipping deleted and non-raw files", async () => {
      await seedPending("plate-reader-d");
      await seedWatcher("plate-reader-d", null);
      const db = getTestDb();
      const [run] = await db
        .insert(instrumentRuns)
        .values({
          instrumentId: "plate-reader-d",
          runId: "run-0001",
          source: "watcher",
        })
        .returning({ id: instrumentRuns.id });
      await db.insert(files).values([
        {
          instrumentRunId: run.id,
          filename: "older_quant.csv",
          relativePath: "older_quant.csv",
          category: "raw",
          createdAt: new Date("2026-01-01T00:00:00Z"),
        },
        {
          instrumentRunId: run.id,
          filename: "newest_quant.csv",
          relativePath: "newest_quant.csv",
          category: "raw",
          createdAt: new Date("2026-01-02T00:00:00Z"),
        },
        {
          instrumentRunId: run.id,
          filename: "deleted_quant.csv",
          relativePath: "deleted_quant.csv",
          category: "raw",
          createdAt: new Date("2026-01-03T00:00:00Z"),
          deletedAt: new Date("2026-01-03T01:00:00Z"),
        },
        {
          instrumentRunId: run.id,
          filename: "report.json",
          relativePath: "report.json",
          category: "processed",
          createdAt: new Date("2026-01-04T00:00:00Z"),
        },
      ]);

      const res = await api(
        "/api/v1/instruments/plate-reader-d/confirm-review",
        { headers: { Cookie: adminCookie } }
      );
      expect(res.status).toBe(200);
      expect((await res.json()).runExample).toEqual({
        path: "newest_quant.csv",
        runId: "newest",
      });
    });

    it("keeps the name of a revoked token and marks it revoked", async () => {
      const pc = await seedTestUser({ tokenName: "Old lab PC token" });
      await getTestDb()
        .update(personalAccessTokens)
        .set({ revokedAt: new Date() })
        .where(eq(personalAccessTokens.id, pc.tokenId));
      await seedPending("plate-reader-e");
      await seedWatcher("plate-reader-e", pc.tokenId);

      const res = await api(
        "/api/v1/instruments/plate-reader-e/confirm-review",
        { headers: { Cookie: adminCookie } }
      );
      expect(res.status).toBe(200);
      expect((await res.json()).watcher).toMatchObject({
        tokenName: "Old lab PC token",
        tokenRevoked: true,
      });
    });

    it("gives a null watcher and no example for an instrument with no watcher", async () => {
      await seedPending("plate-reader-f");

      const res = await api(
        "/api/v1/instruments/plate-reader-f/confirm-review",
        { headers: { Cookie: adminCookie } }
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        displayName: "Plate Reader A",
        instrumentId: "plate-reader-f",
        runExample: null,
        watcher: null,
      });
    });

    it("refuses a member's session with 403", async () => {
      const res = await api(
        "/api/v1/instruments/plate-reader-c/confirm-review",
        { headers: { Cookie: memberCookie } }
      );
      expect(res.status).toBe(403);
    });

    it("refuses a token that can read watchers but is not an admin token", async () => {
      const { token } = await seedTestUser({ scopes: ["watchers:read"] });
      const res = await api(
        "/api/v1/instruments/plate-reader-c/confirm-review",
        { token }
      );
      expect(res.status).toBe(403);
    });

    it("refuses a legacy token with the * scope, which must list watchers:admin itself", async () => {
      const { token } = await seedTestUser({ scopes: ["*"] });
      const res = await api(
        "/api/v1/instruments/plate-reader-c/confirm-review",
        { token }
      );
      expect(res.status).toBe(403);
    });

    it("gives a token that lists watchers:admin the review", async () => {
      const { token } = await seedTestUser({ scopes: ["watchers:admin"] });
      const res = await api(
        "/api/v1/instruments/plate-reader-c/confirm-review",
        { token }
      );
      expect(res.status).toBe(200);
      expect((await res.json()).instrumentId).toBe("plate-reader-c");
    });

    it("returns 404 for an instrument that does not exist", async () => {
      const res = await api(
        "/api/v1/instruments/no-such-instrument/confirm-review",
        { headers: { Cookie: adminCookie } }
      );
      expect(res.status).toBe(404);
    });
  });
});
