import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  api,
  closeTestDb,
  resetDb,
  seedSessionCookie,
  seedTestUser,
} from "@/tests/integration/helpers";

// Renders each settings page as an admin against the production build, so a
// server component that throws while rendering fails here instead of showing
// Next.js's "This page couldn't load" screen on staging.
const SETTINGS_PAGES = [
  "/settings/integrations",
  "/settings/notifications",
  "/settings/feedback",
  "/settings/members",
  "/settings/watchers",
  "/settings/tokens",
];

describe("Settings pages", () => {
  let adminCookie: string;

  beforeAll(async () => {
    await resetDb();
    const admin = await seedTestUser({ isAdmin: true, name: "Admin" });
    adminCookie = await seedSessionCookie(admin.userId);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it.each(SETTINGS_PAGES)("renders %s for an admin", async (path) => {
    const res = await api(path, {
      headers: { Accept: "text/html", Cookie: adminCookie },
      redirect: "manual",
    });
    const html = await res.text();
    expect(html).not.toContain("couldn’t load");
    expect(res.status).toBe(200);
  });
});
