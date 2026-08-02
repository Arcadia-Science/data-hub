import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  api,
  closeTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";

// Tests the authenticateRequest middleware's rejection paths. The middleware
// checks in order: (1) Better Auth session cookie, (2) Bearer scheme,
// (3) dhub_ prefix, (4) token hash in DB, (5) expiry. These tests exercise
// each rejection point via the PAT path (no session cookies in integration tests).
describe("Authentication", () => {
  let validToken: string;

  beforeAll(async () => {
    await resetDb();
    ({ token: validToken } = await seedTestUser());
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("returns 401 when no Authorization header is provided", async () => {
    const res = await api("/api/v1/instruments");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 for a non-Bearer authorization scheme", async () => {
    const res = await api("/api/v1/instruments", {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(res.status).toBe(401);
  });

  // The middleware short-circuits before DB lookup when the token lacks the
  // dhub_ prefix. This prevents unnecessary queries for JWTs or other tokens.
  it("returns 401 for a Bearer token without the dhub_ prefix", async () => {
    const res = await api("/api/v1/instruments", {
      headers: { Authorization: "Bearer some-random-jwt-token" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 for a dhub_ token that does not exist in the database", async () => {
    const res = await api("/api/v1/instruments", {
      token:
        "dhub_0000000000000000000000000000000000000000000000000000000000000000",
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 for an expired PAT", async () => {
    const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const { token: expiredToken } = await seedTestUser({ expiresAt: pastDate });

    const res = await api("/api/v1/instruments", { token: expiredToken });
    expect(res.status).toBe(401);
  });

  it("returns 200 for a valid PAT", async () => {
    const res = await api("/api/v1/instruments", { token: validToken });
    expect(res.status).toBe(200);
  });
});
