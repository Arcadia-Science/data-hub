import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { instrumentRecord } from "@/lib/api/openapi";
import { instruments, watchers } from "@/lib/db/schema";
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
    it("gives an admin the watcher's registration and settings", async () => {
      const pc = await seedTestUser({ tokenName: "Lab PC token" });
      await seedPending("plate-reader-c");
      await getTestDb()
        .insert(watchers)
        .values({
          instrumentId: "plate-reader-c",
          hostname: "LAB-PC-01",
          registeredByToken: pc.tokenId,
          configYaml: [
            "instrument:",
            "  watch_directory: 'D:\\Exports'",
            "  file_patterns:",
            "    - '*.csv'",
            "  run_detection:",
            "    pattern: '^([^_]+)'",
            "    recursive: false",
            "  upload_mode: manual",
          ].join("\n"),
        });

      const res = await api(
        "/api/v1/instruments/plate-reader-c/confirm-review",
        { headers: { Cookie: adminCookie } }
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        displayName: "Plate Reader A",
        instrumentId: "plate-reader-c",
        recentFilePath: null,
        watcher: {
          hostname: "LAB-PC-01",
          tokenName: "Lab PC token",
          filePatterns: ["*.csv"],
          runDetection: { pattern: "^([^_]+)", recursive: false },
          uploadMode: "manual",
          watchDirectory: "D:\\Exports",
        },
      });
    });

    it("refuses a member's session with 403", async () => {
      const res = await api(
        "/api/v1/instruments/plate-reader-c/confirm-review",
        { headers: { Cookie: memberCookie } }
      );
      expect(res.status).toBe(403);
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
