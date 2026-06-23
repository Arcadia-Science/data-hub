import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  api,
  closeTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";

describe("Instruments API", () => {
  let token: string;

  beforeAll(async () => {
    await resetDb();
    ({ token } = await seedTestUser());
  });

  afterAll(async () => {
    await closeTestDb();
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/instruments
  // -------------------------------------------------------------------------

  // New instruments always start as "pending" until an admin confirms them.
  // This prevents unvetted instruments from appearing in the active dashboard.
  it("POST /api/v1/instruments creates an instrument", async () => {
    const res = await api("/api/v1/instruments", {
      method: "POST",
      token,
      body: { id: "test-instrument", display_name: "Test Instrument" },
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.id).toBe("test-instrument");
    expect(data.display_name).toBe("Test Instrument");
    expect(data.status).toBe("pending");
  });

  // When no display_name is provided, the API derives one from the kebab-case
  // id by title-casing each segment (e.g., "plate-reader-abc" → "Plate Reader Abc").
  it("POST /api/v1/instruments derives display_name from kebab-case id", async () => {
    const res = await api("/api/v1/instruments", {
      method: "POST",
      token,
      body: { id: "plate-reader-abc" },
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.display_name).toBe("Plate Reader Abc");
  });

  it("POST /api/v1/instruments returns 409 for duplicate id", async () => {
    const res = await api("/api/v1/instruments", {
      method: "POST",
      token,
      body: { id: "test-instrument" },
    });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error.code).toBe("CONFLICT");
  });

  // Instrument IDs must be kebab-case because they're used as the first
  // segment of S3 keys (e.g., {instrument_id}/{run_id}/{filename}).
  it("POST /api/v1/instruments rejects invalid kebab-case", async () => {
    const res = await api("/api/v1/instruments", {
      method: "POST",
      token,
      body: { id: "Not Kebab Case" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("POST /api/v1/instruments rejects missing id", async () => {
    const res = await api("/api/v1/instruments", {
      method: "POST",
      token,
      body: {},
    });
    expect(res.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/instruments
  // -------------------------------------------------------------------------

  it("GET /api/v1/instruments lists all instruments", async () => {
    const res = await api("/api/v1/instruments", { token });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(2);
    expect(
      data.find((i: { id: string }) => i.id === "test-instrument")
    ).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/instruments/:instrumentId
  // -------------------------------------------------------------------------

  it("GET /api/v1/instruments/:id returns instrument detail with counts", async () => {
    const res = await api("/api/v1/instruments/test-instrument", { token });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe("test-instrument");
    expect(data.display_name).toBe("Test Instrument");
    expect(data).toHaveProperty("run_count");
    expect(data).toHaveProperty("watcher_count");
  });

  it("GET /api/v1/instruments/:id returns 404 for nonexistent id", async () => {
    const res = await api("/api/v1/instruments/nonexistent-instrument", {
      token,
    });
    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // PATCH /api/v1/instruments/:instrumentId
  // -------------------------------------------------------------------------

  it("PATCH /api/v1/instruments/:id updates status", async () => {
    const res = await api("/api/v1/instruments/test-instrument", {
      method: "PATCH",
      token,
      body: { status: "active" },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("active");
  });

  it("PATCH /api/v1/instruments/:id updates display_name", async () => {
    const res = await api("/api/v1/instruments/test-instrument", {
      method: "PATCH",
      token,
      body: {
        display_name: "Renamed Instrument",
      },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.display_name).toBe("Renamed Instrument");
  });

  it("PATCH /api/v1/instruments/:id rejects unknown fields", async () => {
    const res = await api("/api/v1/instruments/test-instrument", {
      method: "PATCH",
      token,
      body: { unknown_field: "value" },
    });
    expect(res.status).toBe(400);
  });

  it("PATCH /api/v1/instruments/:id rejects invalid status", async () => {
    const res = await api("/api/v1/instruments/test-instrument", {
      method: "PATCH",
      token,
      body: { status: "bogus" },
    });
    expect(res.status).toBe(400);
  });

  it("PATCH /api/v1/instruments/:id returns 404 for nonexistent id", async () => {
    const res = await api("/api/v1/instruments/nonexistent", {
      method: "PATCH",
      token,
      body: { status: "active" },
    });
    expect(res.status).toBe(404);
  });
});
