import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { instruments } from "@/lib/db/schema";
import {
  api,
  closeTestDb,
  getTestDb,
  resetDb,
  seedSessionCookie,
  seedTestUser,
} from "@/tests/integration/helpers";

// Routes and the run page read the run ID from the `x-data-hub-raw-path`
// header that `proxy.ts` sets (see `readRunIdParam`). This runs against
// `next start`, which decodes a route parameter once, so it can't show the
// double decoding on Vercel. It checks that the header is the proxy's own and
// that the run page still finds runs whose IDs hold URL characters.
describe("Run ID from the raw path", () => {
  const instrumentId = "raw-path-instrument";
  let token: string;
  let userId: string;

  beforeAll(async () => {
    await resetDb();
    ({ token, userId } = await seedTestUser({ tokenName: "Raw Path Bot" }));
    await getTestDb().insert(instruments).values({
      id: instrumentId,
      displayName: "Raw Path Instrument",
      status: "active",
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  async function createRun(runId: string) {
    const res = await api(`/api/v1/instruments/${instrumentId}/runs`, {
      method: "POST",
      token,
      body: { run_id: runId, source: "lambda" },
    });
    expect(res.status).toBe(201);
  }

  // The proxy replaces the header on every request, and `readRunIdParam`
  // ignores a header that disagrees with the route parameter, so a client
  // can't make a route read another run's ID than the one in its URL.
  it("ignores a raw path header that the client sends", async () => {
    await createRun("header-run-a");
    await createRun("header-run-b");

    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/header-run-a`,
      {
        token,
        headers: {
          "x-data-hub-raw-path": `/api/v1/instruments/${instrumentId}/runs/header-run-b`,
        },
      }
    );
    expect(res.status).toBe(200);
    expect((await res.json()).run_id).toBe("header-run-a");
  });

  it.each([
    "%41",
    "50%",
    "50%25",
    "Plate#3",
    "a?b",
    "two words",
  ])("the run page opens the run whose ID is %j", async (runId) => {
    await createRun(runId);

    const res = await api(
      `/instruments/${instrumentId}/runs/${encodeURIComponent(runId)}`,
      {
        headers: {
          Accept: "text/html",
          Cookie: await seedSessionCookie(userId),
        },
      }
    );
    const html = await res.text();
    expect(res.status).toBe(200);
    // The page title is the run's own ID, so it names the run that was found.
    expect(html).toContain(`<title>${runId} | Raw Path Instrument`);
  });

  it("the run page doesn't find a run that a second decoding would reach", async () => {
    await createRun("QA");
    // `Q%41` would read as `QA` after one decoding too many.
    const res = await api(`/instruments/${instrumentId}/runs/Q%2541`, {
      headers: {
        Accept: "text/html",
        Cookie: await seedSessionCookie(userId),
      },
    });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).not.toContain("<title>QA |");
  });
});
