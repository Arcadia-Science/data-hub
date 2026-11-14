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

// Runs against the production build, so the proxy's sign-in rule, the routes'
// real status codes (404 before any streaming starts, 308 for a permanent
// redirect) and the pages' server rendering are checked as a visitor sees them.

const CONFIG_YAML = `instrument:
  id: watcher-page-a
  watch_directory: /data/plates
  file_patterns:
    - "*.csv"
  run_detection:
    pattern: '^([^_]+)'
    recursive: false
`;

const MINUTE_MS = 60 * 1000;

describe("Watcher pages", () => {
  let adminCookie: string;
  let memberCookie: string;
  let currentId: string;
  let pastId: string;
  let otherInstrumentWatcherId: string;

  beforeAll(async () => {
    await resetDb();
    const admin = await seedTestUser({
      isAdmin: true,
      name: "Admin",
      email: "admin@watcher-pages.test",
    });
    const member = await seedTestUser({
      name: "Member",
      email: "member@watcher-pages.test",
    });
    adminCookie = await seedSessionCookie(admin.userId);
    memberCookie = await seedSessionCookie(member.userId);

    const db = getTestDb();
    await db.insert(instruments).values([
      {
        id: "watcher-page-a",
        displayName: "Watcher Page Instrument A",
        status: "active",
      },
      {
        id: "watcher-page-b",
        displayName: "Watcher Page Instrument B",
        status: "active",
      },
      {
        id: "watcher-page-none",
        displayName: "Watcher Page Instrument None",
        status: "active",
      },
    ]);

    const now = Date.now();
    const [past] = await db
      .insert(watchers)
      .values({
        instrumentId: "watcher-page-a",
        hostname: "OLD-PC",
        osInfo: "Windows 10",
        watcherVersion: "1.3.0",
        status: "stopped",
        configYaml: CONFIG_YAML,
        createdAt: new Date(now - 30 * 24 * 60 * MINUTE_MS),
        deletedAt: new Date(now - 10 * 24 * 60 * MINUTE_MS),
        deregisteredBy: admin.userId,
      })
      .returning({ id: watchers.id });
    const [current] = await db
      .insert(watchers)
      .values({
        instrumentId: "watcher-page-a",
        hostname: "NEW-PC",
        osInfo: "Windows 11",
        watcherVersion: "1.4.2",
        status: "watching",
        lastHeartbeatAt: new Date(now - MINUTE_MS),
        configYaml: CONFIG_YAML,
      })
      .returning({ id: watchers.id });
    const [other] = await db
      .insert(watchers)
      .values({
        instrumentId: "watcher-page-b",
        hostname: "OTHER-PC",
        status: "watching",
        lastHeartbeatAt: new Date(now - MINUTE_MS),
        configYaml: CONFIG_YAML,
      })
      .returning({ id: watchers.id });
    pastId = past.id;
    currentId = current.id;
    otherInstrumentWatcherId = other.id;
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

  describe("the three sub-tabs", () => {
    // `loaded` is text that only the tab's own content renders, never the
    // frame around it or the tab's loading skeleton. The frame sits outside
    // the tab's Suspense boundary, so a tab whose data load threw would still
    // show the frame and fail only on this text.
    const TABS = [
      { path: "/instruments/watcher-page-a/watcher", loaded: "Event Type" },
      {
        path: "/instruments/watcher-page-a/watcher/health",
        loaded: 'aria-label="Status since"',
      },
      {
        path: "/instruments/watcher-page-a/watcher/settings",
        loaded: "Current settings",
      },
    ];

    function expectTabLoaded(html: string, loaded: string) {
      // The root error screen, and the load error boundary's own message.
      expect(html).not.toContain("This page couldn’t load");
      expect(html).not.toContain("Couldn’t load this.");
      expect(html).toContain(loaded);
    }

    it.each(TABS)("$path loads for an admin", async ({ path, loaded }) => {
      const res = await page(path, adminCookie);
      const html = await res.text();
      expect(res.status).toBe(200);
      expectTabLoaded(html, loaded);
      expect(html).toContain("Watcher for Watcher Page Instrument A");
      // The browser tab title, with the root layout's suffix.
      expect(html).toContain(
        "<title>Watcher Page Instrument A · Watcher | Data Hub</title>"
      );
      expect(html).toContain("NEW-PC");
      // The admin menu is there for the current watcher.
      expect(html).toContain('aria-label="Watcher actions"');
    });

    it.each(TABS)("$path loads for a member, without the admin menu", async ({
      path,
      loaded,
    }) => {
      const res = await page(path, memberCookie);
      const html = await res.text();
      expect(res.status).toBe(200);
      expectTabLoaded(html, loaded);
      expect(html).toContain("Watcher for Watcher Page Instrument A");
      expect(html).not.toContain('aria-label="Watcher actions"');
    });

    it("marks the open sub-tab as the current page", async () => {
      const res = await page(
        "/instruments/watcher-page-a/watcher/health",
        memberCookie
      );
      const html = await res.text();
      expect(html).toMatch(
        /aria-current="page"[^>]*href="\/instruments\/watcher-page-a\/watcher\/health"|href="\/instruments\/watcher-page-a\/watcher\/health"[^>]*aria-current="page"/
      );
    });
  });

  describe("the Settings tab", () => {
    it("gives an admin the edit form", async () => {
      const res = await page(
        "/instruments/watcher-page-a/watcher/settings",
        adminCookie
      );
      const html = await res.text();
      expect(html).toContain("Edit settings");
      expect(html).not.toContain("Only admins can change watcher settings.");
    });

    it("gives a member the settings without the form and says why", async () => {
      const res = await page(
        "/instruments/watcher-page-a/watcher/settings",
        memberCookie
      );
      const html = await res.text();
      expect(html).toContain("Current settings");
      expect(html).toContain("Only admins can change watcher settings.");
      expect(html).not.toContain("Edit settings");
    });
  });

  describe("?watcher=", () => {
    it("opens a past watcher of the instrument, read-only", async () => {
      const res = await page(
        `/instruments/watcher-page-a/watcher/settings?watcher=${pastId}`,
        adminCookie
      );
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toContain("viewing a past watcher");
      expect(html).toContain("OLD-PC");
      // An admin still gets no form, and no menu, for a past watcher.
      expect(html).not.toContain("Edit settings");
      expect(html).not.toContain('aria-label="Watcher actions"');
    });

    it("returns 404 for a watcher that belongs to another instrument", async () => {
      for (const path of [
        "/instruments/watcher-page-a/watcher",
        "/instruments/watcher-page-a/watcher/health",
        "/instruments/watcher-page-a/watcher/settings",
      ]) {
        const res = await page(
          `${path}?watcher=${otherInstrumentWatcherId}`,
          adminCookie
        );
        expect(res.status, path).toBe(404);
      }
    });

    it("returns 404 for an ID that is not a watcher at all", async () => {
      const unknown = await page(
        "/instruments/watcher-page-a/watcher?watcher=00000000-0000-4000-8000-000000000000",
        adminCookie
      );
      expect(unknown.status).toBe(404);
      const garbage = await page(
        "/instruments/watcher-page-a/watcher?watcher=not-a-uuid",
        adminCookie
      );
      expect(garbage.status).toBe(404);
    });
  });

  it("returns 404 for an instrument that does not exist", async () => {
    const res = await page(
      "/instruments/no-such-instrument/watcher",
      adminCookie
    );
    expect(res.status).toBe(404);
  });

  it("shows an empty state for an instrument that never had a watcher", async () => {
    const res = await page(
      "/instruments/watcher-page-none/watcher",
      adminCookie
    );
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("No watcher has connected yet.");
  });

  describe("signed out", () => {
    it.each([
      "/instruments/watcher-page-a/watcher",
      "/instruments/watcher-page-a/watcher/health?since=2026-11-01",
      "/instruments/watcher-page-a/watcher/settings?focus=watch_directory",
    ])("sends a visitor from %s to sign-in, to return to the same URL", async (path) => {
      const res = await page(path);
      expect(res.status).toBe(307);
      // Next makes same-host proxy redirects relative, so parse against the app.
      const location = new URL(res.headers.get("location") ?? "", getBaseUrl());
      expect(location.pathname).toBe("/login");
      expect(location.searchParams.get("callbackURL")).toBe(path);
    });

    it("keeps the instrument page itself public for link previews", async () => {
      const res = await page("/instruments/watcher-page-a");
      expect(res.status).toBe(200);
    });
  });

  describe("the old /watchers/<id> URL", () => {
    function redirectTarget(res: Response) {
      return new URL(res.headers.get("location") ?? "", getBaseUrl());
    }

    it("redirects an active watcher to its instrument's watcher page", async () => {
      const res = await page(`/watchers/${currentId}`, adminCookie);
      expect(res.status).toBe(308);
      const target = redirectTarget(res);
      expect(target.pathname).toBe("/instruments/watcher-page-a/watcher");
      expect(target.search).toBe("");
    });

    it.each([
      ["logs", "/instruments/watcher-page-a/watcher"],
      ["status", "/instruments/watcher-page-a/watcher/health"],
      ["configuration", "/instruments/watcher-page-a/watcher/settings"],
    ])("sends ?tab=%s of an active watcher to %s", async (tab, pathname) => {
      const res = await page(`/watchers/${currentId}?tab=${tab}`, memberCookie);
      expect(res.status).toBe(308);
      const target = redirectTarget(res);
      expect(target.pathname).toBe(pathname);
      expect(target.search).toBe("");
    });

    it("keeps ?watcher= for a deregistered watcher, on every tab", async () => {
      const plain = await page(`/watchers/${pastId}`, adminCookie);
      expect(plain.status).toBe(308);
      const plainTarget = redirectTarget(plain);
      expect(plainTarget.pathname).toBe("/instruments/watcher-page-a/watcher");
      expect(plainTarget.searchParams.get("watcher")).toBe(pastId);

      const status = await page(`/watchers/${pastId}?tab=status`, adminCookie);
      expect(status.status).toBe(308);
      const statusTarget = redirectTarget(status);
      expect(statusTarget.pathname).toBe(
        "/instruments/watcher-page-a/watcher/health"
      );
      expect(statusTarget.searchParams.get("watcher")).toBe(pastId);
    });

    it("returns 404 for a watcher that does not exist", async () => {
      const unknown = await page(
        "/watchers/00000000-0000-4000-8000-000000000000",
        adminCookie
      );
      expect(unknown.status).toBe(404);
      const garbage = await page("/watchers/not-a-uuid", adminCookie);
      expect(garbage.status).toBe(404);
    });

    it("sends a signed-out visitor to sign-in first", async () => {
      const res = await page(`/watchers/${currentId}?tab=status`);
      expect(res.status).toBe(307);
      const location = redirectTarget(res);
      expect(location.pathname).toBe("/login");
      expect(location.searchParams.get("callbackURL")).toBe(
        `/watchers/${currentId}?tab=status`
      );
    });
  });
});
