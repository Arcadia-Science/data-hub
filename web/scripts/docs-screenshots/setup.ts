// Data that exists only for screenshots, added on top of the regular seed. The
// shared seed stays as it is, so `make db-reseed` is unaffected.

import {
  LINEAR_STATES,
  LINEAR_TEAM_ID,
  startLinearFakeServer,
} from "@arcadiascience/app-feedback-toolkit/testing";
import { and, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { SCOPE_PRESETS } from "@/lib/api/scope-catalog";
// biome-ignore lint/performance/noNamespaceImport: drizzle scripts need the full schema module for Db typing
import * as schema from "@/lib/db/schema";
import type { SeededRun, SeededTeammate } from "@/lib/db/seed";
import { generateToken, getTokenPrefix, hashToken } from "@/lib/tokens";
import { createSessionCookie } from "./environment";

type Db = NodePgDatabase<typeof schema>;

export interface Cookie {
  name: string;
  value: string;
}

export interface World {
  admin: { email: string; token: string; userId: string };
  baseUrl: string;
  close: () => Promise<void>;
  cookieFor: (userId: string) => Promise<Cookie>;
  db: Db;
  /** Forgets the Linear setup, so the integrations page shows its first step. */
  disconnectLinear: () => Promise<void>;
  /** Connects the fake Linear workspace and files sample reports. Safe to repeat. */
  ensureLinearConnected: () => Promise<void>;
  /** Calls the app's own API as a signed-in user. */
  fetchAs: (
    userId: string,
    path: string,
    init?: { body?: unknown; method?: string }
  ) => Promise<Response>;
  runs: SeededRun[];
  teammates: SeededTeammate[];
}

const LINEAR_SETTINGS = "/api/v1/settings/integrations/linear";

interface SampleReport {
  description: string;
  kind: "bug" | "feature_request" | "other";
  reporter: number;
  resolved?: boolean;
  title: string;
}

// Written the way a lab member would, so the review page looks lived in.
const SAMPLE_REPORTS: readonly SampleReport[] = [
  {
    kind: "bug",
    reporter: 0,
    title: "Plate map colors don't match the legend on 384-well runs",
    description:
      "On a 384-well kinetic run the wells in the bottom rows use the same blue as the legend's lowest value, even when the reading is much higher.",
  },
  {
    kind: "feature_request",
    reporter: 1,
    title: "Download only the processed files for a run",
    description:
      "When I only need the CSVs and plots, I still get the raw files in the zip. A filter on the Download all button would save a lot of time on large runs.",
  },
  {
    kind: "bug",
    reporter: 2,
    title: "Run stays on Processing after I reprocess it",
    description:
      "I reprocessed a gel doc run after fixing the exposure setting and the status never left Processing. Refreshing the page did not help.",
  },
  {
    kind: "other",
    reporter: 3,
    resolved: true,
    title: "Which watcher version do I need on Windows 11?",
    description:
      "The new lab PC runs Windows 11 and I could not tell from the docs whether the latest watcher version supports it.",
  },
];

export function createWorld(options: {
  admin: { email: string; token: string; userId: string };
  baseUrl: string;
  databaseUrl: string;
  linearApiUrl: string;
  runs: SeededRun[];
  teammates: SeededTeammate[];
}): World {
  const pool = new Pool({ connectionString: options.databaseUrl });
  const db = drizzle(pool, { schema });
  const cookies = new Map<string, Cookie>();

  const cookieFor = async (userId: string): Promise<Cookie> => {
    const cached = cookies.get(userId);
    if (cached) {
      return cached;
    }
    const cookie = await createSessionCookie(db, userId);
    cookies.set(userId, cookie);
    return cookie;
  };

  const fetchAs: World["fetchAs"] = async (userId, path, init = {}) => {
    const cookie = await cookieFor(userId);
    return await fetch(`${options.baseUrl}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Cookie: `${cookie.name}=${cookie.value}`,
        "Content-Type": "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  };

  async function expectOk(res: Response, what: string): Promise<void> {
    if (!res.ok) {
      throw new Error(`${what} failed with ${res.status}: ${await res.text()}`);
    }
  }

  let linearReady: Promise<void> | null = null;
  const ensureLinearConnected = () => {
    linearReady ??= connectLinear();
    return linearReady;
  };

  // A database reused with `--skip-seed` may already have Linear connected from
  // an earlier run, and the integrations shot needs the unconnected state.
  const disconnectLinear = async () => {
    linearReady = null;
    await expectOk(
      await fetchAs(options.admin.userId, LINEAR_SETTINGS, {
        method: "DELETE",
      }),
      "Disconnecting Linear"
    );
  };

  async function connectLinear(): Promise<void> {
    const adminId = options.admin.userId;
    await expectOk(
      await fetchAs(adminId, `${LINEAR_SETTINGS}/connect`, {
        method: "POST",
        body: { client_id: "docs-screenshots", client_secret: "unused" },
      }),
      "Connecting Linear"
    );
    await expectOk(
      await fetchAs(adminId, LINEAR_SETTINGS, {
        method: "PUT",
        body: {
          webhook_secret: "whsec_docs_screenshots",
          team: { id: LINEAR_TEAM_ID, name: "Data Hub", key: "DH" },
        },
      }),
      "Saving the Linear team"
    );

    for (const report of SAMPLE_REPORTS) {
      const reporter = options.teammates[report.reporter];
      const res = await fetchAs(reporter.id, "/api/v1/feedback", {
        method: "POST",
        body: {
          kind: report.kind,
          title: report.title,
          description: report.description,
        },
      });
      await expectOk(res, `Filing "${report.title}"`);
      if (report.resolved) {
        const { feedback } = (await res.json()) as { feedback: { id: string } };
        await expectOk(
          await fetch(`${options.linearApiUrl}/__test/issues`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id: feedback.id,
              state: LINEAR_STATES.done,
              completedAt: new Date().toISOString(),
            }),
          }),
          "Closing the sample report"
        );
      }
    }
  }

  return {
    admin: options.admin,
    baseUrl: options.baseUrl,
    close: async () => {
      await pool.end();
    },
    cookieFor,
    db,
    disconnectLinear,
    ensureLinearConnected,
    fetchAs,
    runs: options.runs,
    teammates: options.teammates,
  };
}

export async function startFakeLinear() {
  return await startLinearFakeServer();
}

// A watcher counts as online when its last heartbeat is under five minutes
// old, and a full run takes longer than that after seeding. This moves every
// heartbeat and event forward by the same amount, so the newest one is two
// minutes old and the history around it keeps its shape.
export async function keepWatchersOnline(world: World): Promise<void> {
  const result = await world.db.execute(
    sql`SELECT extract(epoch FROM (now() - interval '2 minutes' - max(last_heartbeat_at))) AS seconds
        FROM watchers WHERE last_heartbeat_at IS NOT NULL`
  );
  const seconds = Number(result.rows[0]?.seconds);
  if (!(seconds > 0)) {
    return;
  }
  const shift = sql`make_interval(secs => ${seconds})`;
  await world.db.transaction(async (tx) => {
    await tx.execute(
      sql`UPDATE watchers SET last_heartbeat_at = last_heartbeat_at + ${shift}
          WHERE last_heartbeat_at IS NOT NULL`
    );
    await tx.execute(
      sql`UPDATE watcher_heartbeats SET timestamp = timestamp + ${shift}, created_at = created_at + ${shift}`
    );
    await tx.execute(
      sql`UPDATE watcher_events SET timestamp = timestamp + ${shift}, created_at = created_at + ${shift}`
    );
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

// The seed's one token has the old full-access scope and a name that looks
// like test data. Replace it with the tokens an admin would actually have.
export async function addSampleTokens(world: World): Promise<void> {
  const now = Date.now();
  const preset = (id: string) =>
    SCOPE_PRESETS.find((p) => p.id === id)?.scopes ?? [];

  await world.db
    .update(schema.personalAccessTokens)
    .set({
      name: "Processing Lambda",
      scopes: preset("lambda"),
      createdAt: new Date(now - 60 * DAY_MS),
    })
    .where(eq(schema.personalAccessTokens.createdBy, world.admin.userId));

  const samples = [
    {
      name: "FPLC watcher, Lab 201",
      scopes: preset("watcher"),
      createdAt: new Date(now - 30 * DAY_MS),
      lastUsedAt: new Date(now - 3 * 60_000),
      expiresAt: new Date(now + 60 * DAY_MS),
    },
    {
      name: "Plate reader analysis notebook",
      scopes: preset("read-only"),
      createdAt: new Date(now - 12 * DAY_MS),
      lastUsedAt: new Date(now - 2 * DAY_MS),
      expiresAt: new Date(now + 78 * DAY_MS),
    },
  ];
  for (const sample of samples) {
    const plaintext = generateToken();
    await world.db.insert(schema.personalAccessTokens).values({
      createdBy: world.admin.userId,
      tokenHash: hashToken(plaintext),
      tokenPrefix: getTokenPrefix(plaintext),
      ...sample,
    });
  }
}

const PENDING_RUN_ID = "20260316_101845_330";

// The seed has no files waiting for approval, and the Hina microscope uploads
// only after someone approves each file. The run is removed again afterwards
// so the dashboard's pending count goes back to zero for the other shots.
export async function addPendingUploadRun(world: World): Promise<void> {
  const [watcher] = await world.db
    .select({ id: schema.watchers.id })
    .from(schema.watchers)
    .where(eq(schema.watchers.instrumentId, "hina-microscope"))
    .limit(1);
  const now = Date.now();
  const [run] = await world.db
    .insert(schema.instrumentRuns)
    .values({
      instrumentId: "hina-microscope",
      runId: PENDING_RUN_ID,
      source: "watcher",
      watcherId: watcher?.id,
      acquiredAt: new Date(now - 25 * 60_000),
    })
    .onConflictDoNothing()
    .returning({ id: schema.instrumentRuns.id });
  if (!run) {
    return;
  }
  await world.db.insert(schema.files).values(
    ["A01", "A02", "A03", "B01", "B02", "B03"].map((well, index) => ({
      instrumentRunId: run.id,
      relativePath: `Well${well}_Point${well}_0000_ChannelBF,FITC,TRITC_Seq000${index}.nd2`,
      filename: `Well${well}_Point${well}_0000_ChannelBF,FITC,TRITC_Seq000${index}.nd2`,
      contentType: "image/nd2",
      sizeBytes: 32_190_464,
      category: "raw" as const,
      status: "detected" as const,
      detectedAt: new Date(now - 20 * 60_000),
      fileCreatedAt: new Date(now - 24 * 60_000),
    }))
  );
}

export async function removePendingUploadRun(world: World): Promise<void> {
  const match = and(
    eq(schema.instrumentRuns.instrumentId, "hina-microscope"),
    eq(schema.instrumentRuns.runId, PENDING_RUN_ID)
  );
  const [run] = await world.db
    .select({ id: schema.instrumentRuns.id })
    .from(schema.instrumentRuns)
    .where(match)
    .limit(1);
  if (!run) {
    return;
  }
  // Files reference the run, so they go first.
  await world.db
    .delete(schema.files)
    .where(eq(schema.files.instrumentRunId, run.id));
  await world.db.delete(schema.instrumentRuns).where(match);
}

export function pendingUploadRunPath(): string {
  return `/instruments/hina-microscope/runs/${PENDING_RUN_ID}`;
}

export async function setRunDeleted(
  world: World,
  instrumentId: string,
  runId: string,
  deleted: boolean
): Promise<void> {
  await world.db
    .update(schema.instrumentRuns)
    .set(
      deleted
        ? { deletedAt: new Date(), deletedBy: world.admin.userId }
        : { deletedAt: null, deletedBy: null }
    )
    .where(
      and(
        eq(schema.instrumentRuns.instrumentId, instrumentId),
        eq(schema.instrumentRuns.runId, runId)
      )
    );
}

// The consent page names the app asking for access, so it needs a client row.
export async function insertConsentClient(
  world: World,
  clientId: string
): Promise<void> {
  const existing = await world.db
    .select({ id: schema.oauthClients.id })
    .from(schema.oauthClients)
    .where(eq(schema.oauthClients.clientId, clientId))
    .limit(1);
  if (existing.length > 0) {
    return;
  }
  const now = new Date();
  await world.db.insert(schema.oauthClients).values({
    id: crypto.randomUUID(),
    clientId,
    name: "Claude",
    redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
    scopes: ["openid", "read", "write"],
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code"],
    responseTypes: ["code"],
    public: true,
    createdAt: now,
    updatedAt: now,
  });
}
