import {
  api,
  closeTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The `/api/v1/users` surface is admin-only and session-only — PATs never
// pass the gate. The full happy-path (admin promoting a teammate) needs a
// session cookie, which the current harness doesn't synthesise. We
// instead lock down the negative cases so the gate is verifiably wired
// up; the session-auth round-trip is covered by manual QA per the PR
// description.

describe("Users API admin gate", () => {
  let token: string;

  beforeAll(async () => {
    await resetDb();
    // Even seeding a user as admin doesn't help here — PATs don't carry a
    // session, and `requireAdmin()` only consults the NextAuth session.
    // This intentionally makes "PAT tries to manage members" a 401, not a
    // 403, so the failure mode is clearly "session required".
    ({ token } = await seedTestUser({ isAdmin: true }));
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("GET /api/v1/users rejects PAT auth (session required)", async () => {
    const res = await api("/api/v1/users", { token });
    expect(res.status).toBe(401);
  });

  it("GET /api/v1/users rejects unauthenticated requests", async () => {
    const res = await api("/api/v1/users");
    expect(res.status).toBe(401);
  });

  it("PATCH /api/v1/users/:userId rejects PAT auth", async () => {
    const res = await api(
      "/api/v1/users/00000000-0000-0000-0000-000000000000",
      {
        method: "PATCH",
        token,
        body: { is_admin: true },
      }
    );
    expect(res.status).toBe(401);
  });

  it("PATCH /api/v1/users/:userId rejects unauthenticated requests", async () => {
    const res = await api(
      "/api/v1/users/00000000-0000-0000-0000-000000000000",
      {
        method: "PATCH",
        body: { is_admin: true },
      }
    );
    expect(res.status).toBe(401);
  });
});
