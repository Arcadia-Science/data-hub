import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { instruments, watchers } from "@/lib/db/schema";
import {
  api,
  closeTestDb,
  getBaseUrl,
  getTestDb,
  resetDb,
  seedSessionCookie,
  seedTestUser,
} from "@/tests/integration/helpers";

// Runs against the production build, like the other page tests, so the
// redirects' status codes and the list's server rendering are checked as a
// visitor sees them. resetDb() sets the release's latest version to 9.9.9.

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

describe("Settings › Watchers and the old /watchers list", () => {
  let adminCookie: string;
  let memberCookie: string;

  beforeAll(async () => {
    await resetDb();
    const admin = await seedTestUser({
      isAdmin: true,
      name: "Admin",
      email: "admin@settings-watchers.test",
    });
    // Who deregistered the past watchers. A separate name, so the check that
    // the list names them can't match the signed-in admin's own name.
    const deregistrar = await seedTestUser({
      isAdmin: true,
      name: "Past Deregistrar",
      email: "deregistrar@settings-watchers.test",
    });
    const member = await seedTestUser({
      name: "Member",
      email: "member@settings-watchers.test",
    });
    adminCookie = await seedSessionCookie(admin.userId);
    memberCookie = await seedSessionCookie(member.userId);

    const db = getTestDb();
    await db.insert(instruments).values([
      {
        id: "roster-plate-a",
        displayName: "Roster Plate Reader A",
        status: "active",
      },
      {
        id: "roster-plate-b",
        displayName: "Roster Plate Reader B",
        status: "active",
      },
      {
        id: "roster-balance-c",
        displayName: "Roster Balance C",
        status: "active",
      },
      {
        id: "roster-scanner-d",
        displayName: "Roster Scanner D",
        status: "active",
      },
    ]);

    const now = Date.now();
    await db.insert(watchers).values([
      // Two active watchers on one computer, whose hostnames differ in case.
      // One is on the latest version (9.9.9) and one is behind (9.9.8).
      {
        instrumentId: "roster-plate-a",
        hostname: "ROSTER-PC-01",
        osInfo: "Windows 11",
        watcherVersion: "9.9.9",
        status: "watching",
        lastHeartbeatAt: new Date(now - MINUTE_MS),
      },
      {
        instrumentId: "roster-plate-b",
        hostname: "roster-pc-01",
        osInfo: "Windows 11",
        watcherVersion: "9.9.8",
        status: "watching",
        lastHeartbeatAt: new Date(now - MINUTE_MS),
      },
      {
        instrumentId: "roster-balance-c",
        hostname: "ROSTER-PC-03",
        osInfo: "Windows 10",
        watcherVersion: "9.9.9",
        status: "watching",
        lastHeartbeatAt: new Date(now - MINUTE_MS),
      },
      // A deregistered watcher with no current one, deregistered by another admin.
      {
        instrumentId: "roster-scanner-d",
        hostname: "ROSTER-PC-04",
        watcherVersion: "9.9.0",
        status: "stopped",
        createdAt: new Date(now - 10 * DAY_MS),
        deletedAt: new Date(now - 2 * DAY_MS),
        deregisteredBy: deregistrar.userId,
      },
      // A deregistered watcher whose hostname matches an active watcher's
      // (differing in case). It must not add a shared-computer marker.
      {
        instrumentId: "roster-balance-c",
        hostname: "roster-pc-03",
        watcherVersion: "9.9.0",
        status: "stopped",
        createdAt: new Date(now - 20 * DAY_MS),
        deletedAt: new Date(now - DAY_MS),
        deregisteredBy: deregistrar.userId,
      },
    ]);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  function page(path: string, cookie?: string) {
    return api(path, {
      headers: { Accept: "text/html", ...(cookie ? { Cookie: cookie } : {}) },
      redirect: "manual",
    });
  }

  function redirectTarget(res: Response) {
    // Next makes same-host redirects relative, so parse against the app.
    return new URL(res.headers.get("location") ?? "", getBaseUrl());
  }

  describe("the old /watchers list", () => {
    it("sends an admin to Settings › Watchers, permanently", async () => {
      const res = await page("/watchers", adminCookie);
      expect(res.status).toBe(308);
      const target = redirectTarget(res);
      expect(target.pathname).toBe("/settings/watchers");
      expect(target.search).toBe("");
    });

    it("keeps ?tab=deregistered for an admin", async () => {
      const res = await page("/watchers?tab=deregistered", adminCookie);
      expect(res.status).toBe(308);
      const target = redirectTarget(res);
      expect(target.pathname).toBe("/settings/watchers");
      expect(target.searchParams.get("tab")).toBe("deregistered");
    });

    it("sends a member to the instruments, permanently, with or without the tab", async () => {
      for (const path of ["/watchers", "/watchers?tab=deregistered"]) {
        const res = await page(path, memberCookie);
        expect(res.status, path).toBe(308);
        expect(redirectTarget(res).pathname, path).toBe("/instruments");
      }
    });

    it("sends a signed-out visitor to sign-in, to return to the same URL", async () => {
      const res = await page("/watchers?tab=deregistered");
      expect(res.status).toBe(307);
      const location = redirectTarget(res);
      expect(location.pathname).toBe("/login");
      expect(location.searchParams.get("callbackURL")).toBe(
        "/watchers?tab=deregistered"
      );
    });
  });

  describe("Settings › Watchers", () => {
    it("renders the release form and the list of all watchers for an admin", async () => {
      const res = await page("/settings/watchers", adminCookie);
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).not.toContain("couldn’t load");
      expect(html).toContain("Release version");
      expect(html).toContain("All watchers");
      // Three active watchers and two deregistered ones.
      expect(html).toContain("Active (3)");
      expect(html).toContain("Deregistered (2)");
      // Two of the three active watchers run the latest version.
      expect(html).toContain("2 of 3 on 9.9.9");
      // The two watchers on one computer each carry the shared marker. The
      // third active watcher's computer matches a deregistered watcher's
      // hostname, which counts for nothing, so it has no marker.
      expect(html.match(/\d on this computer/g)).toEqual([
        "2 on this computer",
        "2 on this computer",
      ]);
      // Each active row links to its instrument's watcher page.
      expect(html).toContain('href="/instruments/roster-plate-a/watcher"');
    });

    it("keeps the list from a member, who sees the admins-only message", async () => {
      const res = await page("/settings/watchers", memberCookie);
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toContain("Admins Only");
      expect(html).not.toContain("All watchers");
    });

    it("leaves Watchers out of the main sidebar", async () => {
      const res = await page("/instruments", adminCookie);
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).not.toContain('href="/watchers"');
    });

    it("lists deregistered watchers on ?tab=deregistered, with who deregistered each", async () => {
      const [scanner] = await getTestDb()
        .select({ id: watchers.id })
        .from(watchers)
        .where(eq(watchers.instrumentId, "roster-scanner-d"));

      const res = await page(
        "/settings/watchers?tab=deregistered",
        adminCookie
      );
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toContain("Deregistered by");
      // Both rows were deregistered by the same person, and the column names
      // them.
      expect(html.match(/>Past Deregistrar</g)).toHaveLength(2);
      // Each row opens the registration it names, not the instrument's
      // current watcher.
      expect(html).toContain(
        `href="/instruments/roster-scanner-d/watcher?watcher=${scanner.id}"`
      );
    });
  });

  describe("deregistering from the row menu", () => {
    it("is refused for a member, and leaves the watcher registered", async () => {
      const [active] = await getTestDb()
        .select({ id: watchers.id })
        .from(watchers)
        .where(
          and(
            eq(watchers.instrumentId, "roster-balance-c"),
            isNull(watchers.deletedAt)
          )
        );

      const res = await api(`/api/v1/watchers/${active.id}`, {
        method: "DELETE",
        headers: { Cookie: memberCookie },
      });
      expect(res.status).toBe(403);

      const [after] = await getTestDb()
        .select({ deletedAt: watchers.deletedAt })
        .from(watchers)
        .where(eq(watchers.id, active.id));
      expect(after.deletedAt).toBeNull();
    });
  });
});
