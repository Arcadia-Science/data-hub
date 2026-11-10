import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  watcherConfigPushResponse,
  watcherConfigRevision,
  watcherConfigRevisionsListResponse,
  watcherDetail,
  watcherHeartbeatAck,
} from "@/lib/api/openapi";
import { getWatcherConfigState } from "@/lib/api/watcher-config/revisions";
import type { WatcherConfigSettings } from "@/lib/api/watcher-config/settings";
import { getWatcherList } from "@/lib/api/watchers";
import {
  files,
  instrumentRuns,
  instruments,
  watcherConfigRevisions,
  watcherEvents,
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

const WATCHER_SCOPES = [
  "watchers:report",
  "watchers:read",
  "instruments:read",
  "instruments:write",
] as const;

const INSTRUMENT_ID = "config-revision-instrument";

const BASE: WatcherConfigSettings = {
  watch_directory: "/data/plate",
  file_patterns: ["*.csv"],
  run_detection: { pattern: "^([^_]+)", recursive: false },
  upload_mode: "auto",
  stability_period_seconds: 5,
  max_stability_wait_seconds: 300,
  upload_parallelism: 4,
};

// The YAML a watcher would push for these settings, with the fields that
// can't be edited from the web around them.
function configYaml(settings: WatcherConfigSettings): string {
  return YAML.stringify({
    version: 1,
    environment: "staging",
    api_base_urls: { staging: "http://localhost" },
    watcher_ids: {},
    instrument: { id: INSTRUMENT_ID, ...settings },
  });
}

describe("Watcher config revisions", () => {
  let watcherToken: string;
  let watcherTokenId: string;
  let otherWatcherToken: string;
  let adminScopeToken: string;
  let legacyWriteToken: string;
  let wildcardToken: string;
  let readOnlyToken: string;
  let adminCookie: string;
  let memberCookie: string;
  let adminUserId: string;
  let watcherId: string;

  const db = () => getTestDb();
  const base = () => `/api/v1/watchers/${watcherId}`;

  async function heartbeat(body: Record<string, unknown> = {}) {
    return await api(`${base()}/heartbeat`, {
      method: "POST",
      token: watcherToken,
      body: { status: "watching", watcher_version: "1.3.0", ...body },
    });
  }

  async function pushConfig(
    settings: WatcherConfigSettings,
    extra: Record<string, unknown> = {}
  ) {
    const res = await api(`${base()}/config`, {
      method: "PUT",
      token: watcherToken,
      body: {
        config_checksum: `sha-${JSON.stringify(settings).length}`,
        config_yaml: configYaml(settings),
        ...extra,
      },
    });
    expect(res.status).toBe(200);
    return watcherConfigPushResponse.parse(await res.json());
  }

  async function saveFromWeb(
    settings: WatcherConfigSettings,
    baseRevision: number | null,
    auth: { cookie?: string; token?: string } = { cookie: adminCookie }
  ) {
    return await api(`${base()}/config-revisions`, {
      method: "POST",
      token: auth.token,
      headers: auth.cookie ? { Cookie: auth.cookie } : {},
      body: { base_revision: baseRevision, settings },
    });
  }

  async function reportResult(
    revision: number,
    body: { status: "applied" | "rejected"; reason?: string }
  ) {
    const res = await api(`${base()}/config-revisions/${revision}/result`, {
      method: "POST",
      token: watcherToken,
      body,
    });
    expect(res.status).toBe(200);
  }

  async function revisions() {
    return await db()
      .select()
      .from(watcherConfigRevisions)
      .where(eq(watcherConfigRevisions.watcherId, watcherId))
      .orderBy(watcherConfigRevisions.revision);
  }

  async function watcherRow() {
    const [row] = await db()
      .select()
      .from(watchers)
      .where(eq(watchers.id, watcherId));
    return row;
  }

  beforeAll(async () => {
    await resetDb();
    ({ token: watcherToken, tokenId: watcherTokenId } = await seedTestUser({
      scopes: [...WATCHER_SCOPES],
      tokenName: "Lab PC token",
    }));
    ({ token: otherWatcherToken } = await seedTestUser({
      scopes: [...WATCHER_SCOPES],
    }));
    ({ token: adminScopeToken } = await seedTestUser({
      scopes: ["watchers:admin"],
    }));
    // Old watcher PCs carry these; `hasScope` reads both as watchers:admin.
    ({ token: legacyWriteToken } = await seedTestUser({
      scopes: ["watchers:write"],
    }));
    ({ token: wildcardToken } = await seedTestUser({ scopes: ["*"] }));
    ({ token: readOnlyToken } = await seedTestUser({
      scopes: ["watchers:read"],
    }));
    const admin = await seedTestUser({ isAdmin: true, name: "Ada Admin" });
    adminUserId = admin.userId;
    adminCookie = await seedSessionCookie(admin.userId);
    const member = await seedTestUser({ isAdmin: false });
    memberCookie = await seedSessionCookie(member.userId);

    await db().insert(instruments).values({
      id: INSTRUMENT_ID,
      displayName: "Config Revision Instrument",
      status: "active",
    });
  });

  // Each test starts from a freshly registered watcher on 1.3.0.
  beforeEach(async () => {
    await db().delete(watcherConfigRevisions);
    await db().delete(watcherEvents);
    await db()
      .update(watchers)
      .set({ deletedAt: new Date() })
      .where(eq(watchers.instrumentId, INSTRUMENT_ID));
    const reg = await api("/api/v1/watchers/register", {
      method: "POST",
      token: watcherToken,
      body: { instrument_id: INSTRUMENT_ID, hostname: "lab-pc" },
    });
    expect(reg.status).toBe(201);
    watcherId = (await reg.json()).watcher_id;
    expect((await heartbeat()).status).toBe(200);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  // -------------------------------------------------------------------------
  // Heartbeat
  // -------------------------------------------------------------------------

  describe("heartbeat", () => {
    it("replies with the latest revision number", async () => {
      const before = await heartbeat();
      expect(watcherHeartbeatAck.parse(await before.json())).toEqual({
        ok: true,
        config_revision: null,
      });

      await pushConfig(BASE);
      expect(
        (await saveFromWeb({ ...BASE, upload_mode: "manual" }, 1)).status
      ).toBe(201);

      const after = await heartbeat();
      expect(await after.json()).toEqual({ ok: true, config_revision: 2 });
    });

    it("stores the waiting status and reason, and clears the reason after", async () => {
      const res = await heartbeat({
        status: "waiting",
        status_reason: "watch_directory not found: D:\\Exports",
      });
      expect(res.status).toBe(200);
      let row = await watcherRow();
      expect(row.status).toBe("waiting");
      expect(row.statusReason).toBe("watch_directory not found: D:\\Exports");

      const detail = await api(base(), { token: readOnlyToken });
      const body = watcherDetail.parse(await detail.json());
      expect(body.status).toBe("waiting");
      expect(body.status_reason).toBe("watch_directory not found: D:\\Exports");

      await heartbeat({ status: "watching", status_reason: "ignored" });
      row = await watcherRow();
      expect(row.status).toBe("watching");
      expect(row.statusReason).toBeNull();
    });

    it("records the applied revision the watcher reports", async () => {
      await heartbeat({ config_revision: 3 });
      expect((await watcherRow()).appliedConfigRevision).toBe(3);
      // Older watchers don't send the field, which leaves it alone.
      await heartbeat();
      expect((await watcherRow()).appliedConfigRevision).toBe(3);
    });

    it("rejects an over-long reason", async () => {
      const res = await heartbeat({
        status: "waiting",
        status_reason: "x".repeat(501),
      });
      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // Admin POST
  // -------------------------------------------------------------------------

  describe("POST /config-revisions", () => {
    beforeEach(async () => {
      await pushConfig(BASE);
    });

    it("lets an admin save a pending web revision", async () => {
      const res = await saveFromWeb({ ...BASE, file_patterns: ["*.AZE"] }, 1);
      expect(res.status).toBe(201);
      const body = watcherConfigRevision.parse(await res.json());
      expect(body).toMatchObject({
        revision: 2,
        source: "web",
        status: "pending",
        status_reason: null,
        resolved_at: null,
        created_by: { id: adminUserId, name: "Ada Admin" },
        created_by_token: null,
      });
      expect(body.settings.file_patterns).toEqual(["*.AZE"]);
      expect((await watcherRow()).configRevision).toBe(2);
    });

    it("refuses a member's session with 403", async () => {
      const res = await saveFromWeb({ ...BASE, upload_mode: "manual" }, 1, {
        cookie: memberCookie,
      });
      expect(res.status).toBe(403);
      expect(await revisions()).toHaveLength(1);
    });

    it("accepts a token with watchers:admin and records the token", async () => {
      const res = await saveFromWeb({ ...BASE, upload_mode: "manual" }, 1, {
        token: adminScopeToken,
      });
      expect(res.status).toBe(201);
      const body = watcherConfigRevision.parse(await res.json());
      expect(body.created_by).toBeNull();
      expect(body.created_by_token).not.toBeNull();
    });

    it("refuses legacy tokens that only imply watchers:admin", async () => {
      for (const token of [legacyWriteToken, wildcardToken]) {
        const res = await saveFromWeb({ ...BASE, upload_mode: "manual" }, 1, {
          token,
        });
        expect(res.status).toBe(403);
        expect((await res.json()).error.message).toMatch(
          /lists watchers:admin explicitly/
        );
      }
      expect(await revisions()).toHaveLength(1);

      // Deregistering keeps accepting them.
      const deleted = await api(base(), {
        method: "DELETE",
        token: legacyWriteToken,
      });
      expect(deleted.status).toBe(200);
    });

    it("refuses a token without watchers:admin", async () => {
      const res = await saveFromWeb({ ...BASE, upload_mode: "manual" }, 1, {
        token: readOnlyToken,
      });
      expect(res.status).toBe(403);
    });

    it("refuses a stale base revision with 409", async () => {
      expect(
        (await saveFromWeb({ ...BASE, upload_mode: "manual" }, 1)).status
      ).toBe(201);
      const res = await saveFromWeb({ ...BASE, upload_parallelism: 8 }, 1);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        error: {
          code: "CONFLICT",
          details: { reason: "stale_revision", latest_revision: 2 },
        },
      });
      const nullBase = await saveFromWeb(
        { ...BASE, upload_parallelism: 8 },
        null
      );
      expect(nullBase.status).toBe(409);
    });

    it("refuses a watcher older than 1.3.0 with 409", async () => {
      await heartbeat({ watcher_version: "1.2.9" });
      const res = await saveFromWeb({ ...BASE, upload_mode: "manual" }, 1);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        error: {
          code: "CONFLICT",
          details: {
            reason: "watcher_update_required",
            min_version: "1.3.0",
            watcher_version: "1.2.9",
          },
        },
      });
      expect(await revisions()).toHaveLength(1);
    });

    it("refuses invalid settings with 400", async () => {
      const res = await saveFromWeb(
        {
          ...BASE,
          run_detection: { pattern: "(?P<run>[^_]+)", recursive: false },
        },
        1
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
    });

    it("refuses settings equal to the latest revision", async () => {
      const res = await saveFromWeb(BASE, 1);
      expect(res.status).toBe(400);
      expect((await res.json()).error.message).toBe("No changes");
    });

    it("allows any save after a rejection, then refuses no change again", async () => {
      const moved = { ...BASE, watch_directory: "/data/new-plate" };
      expect((await saveFromWeb(moved, 1)).status).toBe(201);
      await reportResult(2, {
        status: "rejected",
        reason: "watch_directory not found: /data/new-plate",
      });

      // Once the folder exists, the rejected settings can be saved again.
      const retry = await saveFromWeb(moved, 2);
      expect(retry.status).toBe(201);
      expect(watcherConfigRevision.parse(await retry.json())).toMatchObject({
        revision: 3,
        status: "pending",
        settings: moved,
      });

      // After another rejection, the admin can go back to the settings the
      // watcher kept, which clears the rejection.
      await reportResult(3, { status: "rejected", reason: "still missing" });
      const back = await saveFromWeb(BASE, 3);
      expect(back.status).toBe(201);

      // That's now pending, so saving it again is no change.
      const same = await saveFromWeb(BASE, 4);
      expect(same.status).toBe(400);
      expect((await same.json()).error.message).toBe("No changes");
    });

    it("supersedes an older pending web revision", async () => {
      await saveFromWeb({ ...BASE, upload_mode: "manual" }, 1);
      await saveFromWeb({ ...BASE, upload_parallelism: 2 }, 2);
      const rows = await revisions();
      expect(rows.map((r) => [r.revision, r.status])).toEqual([
        [1, "applied"],
        [2, "superseded"],
        [3, "pending"],
      ]);
      expect(rows[1].resolvedAt).not.toBeNull();
    });

    it("returns 404 for a deregistered watcher", async () => {
      await db()
        .update(watchers)
        .set({ deletedAt: new Date() })
        .where(eq(watchers.id, watcherId));
      const res = await saveFromWeb({ ...BASE, upload_mode: "manual" }, 1);
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // GET history and latest
  // -------------------------------------------------------------------------

  describe("reading revisions", () => {
    it("lists history newest first for any member, with a limit", async () => {
      await pushConfig(BASE);
      await saveFromWeb({ ...BASE, upload_mode: "manual" }, 1);
      const res = await api(`${base()}/config-revisions`, {
        headers: { Cookie: memberCookie },
      });
      expect(res.status).toBe(200);
      const body = watcherConfigRevisionsListResponse.parse(await res.json());
      expect(body.data.map((r) => r.revision)).toEqual([2, 1]);
      expect(body.data[1].created_by_token?.name).toBe("Lab PC token");

      const limited = await api(`${base()}/config-revisions?limit=1`, {
        token: readOnlyToken,
      });
      expect((await limited.json()).data).toHaveLength(1);
      const bad = await api(`${base()}/config-revisions?limit=0`, {
        token: readOnlyToken,
      });
      expect(bad.status).toBe(400);
    });

    it("serves the latest revision to the bound watcher token only", async () => {
      const none = await api(`${base()}/config-revisions/latest`, {
        token: watcherToken,
      });
      expect(none.status).toBe(404);
      expect((await none.json()).error.code).toBe("NOT_FOUND");

      await pushConfig(BASE);
      await saveFromWeb({ ...BASE, upload_mode: "manual" }, 1);
      const res = await api(`${base()}/config-revisions/latest`, {
        token: watcherToken,
      });
      expect(res.status).toBe(200);
      const body = watcherConfigRevision.parse(await res.json());
      expect(body).toMatchObject({ revision: 2, status: "pending" });
      expect(body.settings.upload_mode).toBe("manual");

      const other = await api(`${base()}/config-revisions/latest`, {
        token: otherWatcherToken,
      });
      expect(other.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // Result endpoint
  // -------------------------------------------------------------------------

  describe("POST /config-revisions/:revision/result", () => {
    async function report(revision: number, body: Record<string, unknown>) {
      return await api(`${base()}/config-revisions/${revision}/result`, {
        method: "POST",
        token: watcherToken,
        body,
      });
    }

    async function events() {
      return await db()
        .select()
        .from(watcherEvents)
        .where(eq(watcherEvents.watcherId, watcherId))
        .orderBy(desc(watcherEvents.id));
    }

    beforeEach(async () => {
      await pushConfig(BASE);
      await saveFromWeb({ ...BASE, upload_mode: "manual" }, 1);
    });

    it("moves pending to applied once, writing one event", async () => {
      const res = await report(2, { status: "applied" });
      expect(res.status).toBe(200);
      const body = watcherConfigRevision.parse(await res.json());
      expect(body.status).toBe("applied");
      expect(body.resolved_at).not.toBeNull();
      expect((await watcherRow()).appliedConfigRevision).toBe(2);

      const repeat = await report(2, { status: "applied" });
      expect(repeat.status).toBe(200);

      const rows = await events();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        eventType: "config_synced",
        details: { kind: "config_revision_applied", revision: 2 },
      });

      const conflict = await report(2, { status: "rejected", reason: "late" });
      expect(conflict.status).toBe(409);
      expect((await conflict.json()).error.code).toBe("CONFLICT");
    });

    it("moves pending to rejected with the reason and an error event", async () => {
      const reason = "watch_directory not found: /data/missing";
      const res = await report(2, { status: "rejected", reason });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        status: "rejected",
        status_reason: reason,
      });
      // A rejected revision is never applied.
      expect((await watcherRow()).appliedConfigRevision).toBe(1);
      const [event] = await events();
      expect(event).toMatchObject({
        eventType: "error",
        details: { kind: "config_revision_rejected", revision: 2, reason },
      });

      expect((await report(2, { status: "rejected" })).status).toBe(200);
      expect((await report(2, { status: "applied" })).status).toBe(409);
    });

    it("refuses to resolve a superseded revision", async () => {
      await saveFromWeb({ ...BASE, upload_parallelism: 2 }, 2);
      const res = await report(2, { status: "applied" });
      expect(res.status).toBe(409);
    });

    it("returns 404 for an unknown revision and 400 for a bad one", async () => {
      expect((await report(99, { status: "applied" })).status).toBe(404);
      expect((await report(0, { status: "applied" })).status).toBe(400);
      const badBody = await report(2, { status: "superseded" });
      expect(badBody.status).toBe(400);
    });

    it("only accepts the watcher's own token", async () => {
      const res = await api(`${base()}/config-revisions/2/result`, {
        method: "POST",
        token: otherWatcherToken,
        body: { status: "applied" },
      });
      expect(res.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // PUT /config revision logic
  // -------------------------------------------------------------------------

  describe("PUT /config", () => {
    it("creates revision 1 from the first push", async () => {
      const body = await pushConfig(BASE);
      expect(body.config_revision).toBe(1);
      const [rev] = await revisions();
      expect(rev).toMatchObject({
        revision: 1,
        source: "pc",
        status: "applied",
        createdBy: null,
        createdByToken: watcherTokenId,
      });
      const row = await watcherRow();
      expect(row.configRevision).toBe(1);
      expect(row.appliedConfigRevision).toBe(1);
    });

    it("skips the revision logic when the YAML can't be parsed, and says why", async () => {
      const res = await api(`${base()}/config`, {
        method: "PUT",
        token: watcherToken,
        body: { config_checksum: "x", config_yaml: "instrument: {}\n" },
      });
      expect(await res.json()).toEqual({
        config_checksum: "x",
        config_revision: null,
      });
      expect(await revisions()).toHaveLength(0);

      // The Configuration tab explains it instead of an empty form.
      const state = await getWatcherConfigState(await watcherRow());
      expect(state.baseSettings).toBeNull();
      expect(state.reportedProblem).toMatch(/^instrument\.watch_directory: /);

      await pushConfig(BASE);
      expect(
        (await getWatcherConfigState(await watcherRow())).reportedProblem
      ).toBeNull();
    });

    it("does nothing when the settings match the latest revision", async () => {
      await pushConfig(BASE);
      const body = await pushConfig(BASE, { based_on_revision: 1 });
      expect(body.config_revision).toBe(1);
      expect(await revisions()).toHaveLength(1);
    });

    it("marks a matching pending revision applied when the watcher has seen it", async () => {
      await pushConfig(BASE);
      const next = { ...BASE, upload_mode: "manual" as const };
      await saveFromWeb(next, 1);

      // Not seen yet: stays pending.
      await pushConfig(next, { based_on_revision: 1 });
      expect((await revisions())[1].status).toBe("pending");

      await pushConfig(next, { based_on_revision: 2 });
      const rows = await revisions();
      expect(rows).toHaveLength(2);
      expect(rows[1].status).toBe("applied");
      expect((await watcherRow()).appliedConfigRevision).toBe(2);
    });

    it("records a PC edit as an applied pc revision", async () => {
      await pushConfig(BASE);
      const edited = { ...BASE, file_patterns: ["*.csv", "*.txt"] };
      const body = await pushConfig(edited, { based_on_revision: 1 });
      expect(body.config_revision).toBe(2);
      const rows = await revisions();
      expect(rows[1]).toMatchObject({
        revision: 2,
        source: "pc",
        status: "applied",
      });
      expect((await watcherRow()).appliedConfigRevision).toBe(2);
    });

    it("lets a newer offline PC edit beat a pending web change", async () => {
      await pushConfig(BASE);
      await saveFromWeb({ ...BASE, upload_mode: "manual" }, 1);
      const pcEdit = { ...BASE, upload_parallelism: 1 };
      const body = await pushConfig(pcEdit, {
        based_on_revision: 1,
        modified_at: new Date(Date.now() + 60_000).toISOString(),
      });
      expect(body.config_revision).toBe(3);
      const rows = await revisions();
      expect(rows.map((r) => [r.revision, r.source, r.status])).toEqual([
        [1, "pc", "applied"],
        [2, "web", "superseded"],
        [3, "pc", "applied"],
      ]);
      const row = await watcherRow();
      expect(row.configRevision).toBe(3);
      expect(row.appliedConfigRevision).toBe(3);
    });

    it("keeps an older offline PC edit as history and leaves the web change pending", async () => {
      await pushConfig(BASE);
      const webChange = { ...BASE, upload_mode: "manual" as const };
      await saveFromWeb(webChange, 1);
      const pcEdit = { ...BASE, upload_parallelism: 1 };
      const olderThanWeb = new Date(Date.now() - 60 * 60_000).toISOString();

      const body = await pushConfig(pcEdit, {
        based_on_revision: 1,
        modified_at: olderThanWeb,
      });
      expect(body.config_revision).toBe(3);
      let rows = await revisions();
      expect(rows.map((r) => [r.revision, r.source, r.status])).toEqual([
        [1, "pc", "applied"],
        [2, "web", "pending"],
        [3, "pc", "superseded"],
      ]);
      expect(rows[2].settings).toEqual(pcEdit);

      // The heartbeat reports the highest number; the latest route serves the
      // pending web change ahead of the higher superseded PC edit.
      expect(await (await heartbeat()).json()).toEqual({
        ok: true,
        config_revision: 3,
      });
      const latest = await api(`${base()}/config-revisions/latest`, {
        token: watcherToken,
      });
      expect(await latest.json()).toMatchObject({
        revision: 2,
        status: "pending",
        settings: webChange,
      });

      // Pushing the same offline edit again doesn't add more revisions.
      await pushConfig(pcEdit, {
        based_on_revision: 1,
        modified_at: olderThanWeb,
      });
      rows = await revisions();
      expect(rows).toHaveLength(3);
      expect((await watcherRow()).appliedConfigRevision).toBe(1);

      // The admin's next save is based on the highest number, and compares
      // against the pending change rather than the superseded PC edit.
      const same = await saveFromWeb(webChange, 3);
      expect(same.status).toBe(400);

      // Once the watcher applies the web change and pushes it, nothing new is
      // recorded, and the latest route falls back to the highest revision.
      const result = await api(`${base()}/config-revisions/2/result`, {
        method: "POST",
        token: watcherToken,
        body: { status: "applied" },
      });
      expect(result.status).toBe(200);
      await pushConfig(webChange, { based_on_revision: 2 });
      rows = await revisions();
      expect(rows).toHaveLength(3);
      const after = await api(`${base()}/config-revisions/latest`, {
        token: watcherToken,
      });
      expect(await after.json()).toMatchObject({
        revision: 3,
        status: "superseded",
      });
    });

    it("marks a pending change applied when the watcher pushes it before reporting", async () => {
      await pushConfig(BASE);
      const webChange = { ...BASE, upload_mode: "manual" as const };
      await saveFromWeb(webChange, 1);
      await pushConfig(
        { ...BASE, upload_parallelism: 1 },
        { based_on_revision: 1 }
      );
      // Revision 3 is the superseded PC edit above pending revision 2.
      await pushConfig(webChange, { based_on_revision: 2 });
      const rows = await revisions();
      expect(rows.map((r) => [r.revision, r.status])).toEqual([
        [1, "applied"],
        [2, "applied"],
        [3, "superseded"],
      ]);
      expect((await watcherRow()).appliedConfigRevision).toBe(2);
    });

    it("lets a later PC edit replace a pending change", async () => {
      await pushConfig(BASE);
      await saveFromWeb({ ...BASE, upload_mode: "manual" }, 1);
      await pushConfig(
        { ...BASE, upload_parallelism: 1 },
        { based_on_revision: 1 }
      );
      // A newer PC edit after the offline conflict wins over the web change.
      await pushConfig(
        { ...BASE, upload_parallelism: 2 },
        {
          based_on_revision: 1,
          modified_at: new Date(Date.now() + 60_000).toISOString(),
        }
      );
      const rows = await revisions();
      expect(rows.map((r) => [r.revision, r.source, r.status])).toEqual([
        [1, "pc", "applied"],
        [2, "web", "superseded"],
        [3, "pc", "superseded"],
        [4, "pc", "applied"],
      ]);
    });

    it("records nothing when a push after a rejection matches what the watcher runs", async () => {
      await pushConfig(BASE);
      await saveFromWeb({ ...BASE, watch_directory: "/data/missing" }, 1);
      await reportResult(2, { status: "rejected", reason: "not found" });

      // For example the watcher restarts and pushes its unchanged file.
      const body = await pushConfig(BASE, { based_on_revision: 1 });
      expect(body.config_revision).toBe(2);
      const rows = await revisions();
      expect(rows.map((r) => [r.revision, r.status])).toEqual([
        [1, "applied"],
        [2, "rejected"],
      ]);
    });

    it("keeps a pending change when the PC file changed but its settings didn't", async () => {
      await pushConfig(BASE);
      await saveFromWeb({ ...BASE, upload_mode: "manual" }, 1);

      // A file saved on the PC after the web change, with only fields Data
      // Hub doesn't edit changed (such as `initial_scan`), doesn't win.
      const newer = new Date(Date.now() + 60_000).toISOString();
      const body = await pushConfig(BASE, {
        based_on_revision: 1,
        modified_at: newer,
      });
      expect(body.config_revision).toBe(2);
      // Nor does a CLI push, which sends no based_on_revision.
      await pushConfig(BASE, { modified_at: newer });
      // An older file isn't recorded as an offline edit either.
      await pushConfig(BASE, {
        based_on_revision: 1,
        modified_at: new Date(Date.now() - 60 * 60_000).toISOString(),
      });

      const rows = await revisions();
      expect(rows.map((r) => [r.revision, r.source, r.status])).toEqual([
        [1, "pc", "applied"],
        [2, "web", "pending"],
      ]);
      const row = await watcherRow();
      expect(row.configRevision).toBe(2);
      expect(row.appliedConfigRevision).toBe(1);
    });

    it("treats a push with no modified_at as older than the web change", async () => {
      await pushConfig(BASE);
      await saveFromWeb({ ...BASE, upload_mode: "manual" }, 1);
      await pushConfig({ ...BASE, upload_parallelism: 1 });
      const rows = await revisions();
      expect(rows.map((r) => [r.source, r.status])).toEqual([
        ["pc", "applied"],
        ["web", "pending"],
        ["pc", "superseded"],
      ]);
    });

    it("shows a PC edit made while the watcher runs as waiting for a restart", async () => {
      async function listed() {
        const all = await getWatcherList({ includeDeleted: false });
        const row = all.find((w) => w.id === watcherId);
        if (!row) {
          throw new Error("watcher missing from the list");
        }
        return row;
      }
      async function configState() {
        return await getWatcherConfigState(await watcherRow());
      }

      await pushConfig(BASE);
      await heartbeat({ config_revision: 1 });

      // `config edit` on the PC pushes at once, with no based_on_revision,
      // but the running watcher only reads config.yaml at startup.
      const edited = { ...BASE, file_patterns: ["*.csv", "*.txt"] };
      await pushConfig(edited, { modified_at: new Date().toISOString() });
      await heartbeat({ config_revision: 1 });

      // The history keeps the edit as applied; what's running is revision 1.
      expect((await revisions())[1]).toMatchObject({
        revision: 2,
        source: "pc",
        status: "applied",
      });
      expect((await listed()).pcEditAwaitingRestart).toBe(true);
      let state = await configState();
      expect(state.running).toEqual({ revision: 1, settings: BASE });
      expect(state.restartPending?.revision).toBe(2);

      // After a restart the watcher loads the file and reports revision 2.
      await heartbeat({ config_revision: 2 });
      expect((await listed()).pcEditAwaitingRestart).toBe(false);
      state = await configState();
      expect(state.running).toEqual({ revision: 2, settings: edited });
      expect(state.restartPending).toBeNull();
    });

    it("doesn't wait for a restart when a newer change is pending", async () => {
      await pushConfig(BASE);
      await heartbeat({ config_revision: 1 });
      await pushConfig({ ...BASE, upload_parallelism: 2 });
      await heartbeat({ config_revision: 1 });
      // Applying this replaces the PC edit, so it never takes effect.
      await saveFromWeb({ ...BASE, upload_mode: "manual" }, 2);
      const state = await getWatcherConfigState(await watcherRow());
      expect(state.restartPending).toBeNull();
      const all = await getWatcherList({ includeDeleted: false });
      expect(all.find((w) => w.id === watcherId)?.pcEditAwaitingRestart).toBe(
        false
      );
    });

    it("treats a retyped folder as the same folder", async () => {
      const windows = { ...BASE, watch_directory: "D:\\Exports\\Plate" };
      await pushConfig(windows);
      const [run] = await db()
        .insert(instrumentRuns)
        .values({ instrumentId: INSTRUMENT_ID, runId: "retyped-folder-run" })
        .returning({ id: instrumentRuns.id });
      try {
        await db().insert(files).values({
          instrumentRunId: run.id,
          filename: "a.csv",
          relativePath: "a.csv",
          status: "upload_requested",
          uploadRequestedAt: new Date(),
        });

        // The same folder with a trailing separator is no change on its own.
        const same = await saveFromWeb(
          { ...windows, watch_directory: "D:\\Exports\\Plate\\" },
          1
        );
        expect(same.status).toBe(400);
        expect((await same.json()).error.message).toBe("No changes");

        // Retyped with other slashes and case alongside a pattern change: the
        // text is stored as typed, and pending upload requests stay queued.
        const retyped = {
          ...windows,
          watch_directory: "d:/exports/plate/",
          file_patterns: ["*.csv", "*.txt"],
        };
        await pushConfig(retyped, { based_on_revision: 1 });
        const [file] = await db()
          .select({ status: files.status })
          .from(files)
          .where(eq(files.instrumentRunId, run.id));
        expect(file.status).toBe("upload_requested");
        const rows = await revisions();
        expect(rows[1].settings).toMatchObject({
          watch_directory: "d:/exports/plate/",
        });
      } finally {
        await db().delete(files).where(eq(files.instrumentRunId, run.id));
        await db().delete(instrumentRuns).where(eq(instrumentRuns.id, run.id));
      }
    });

    it("keeps cancelling upload requests when the folder changes", async () => {
      await pushConfig(BASE);
      const [run] = await db()
        .insert(instrumentRuns)
        .values({ instrumentId: INSTRUMENT_ID, runId: "folder-move-run" })
        .returning({ id: instrumentRuns.id });
      await db().insert(files).values({
        instrumentRunId: run.id,
        filename: "a.csv",
        relativePath: "a.csv",
        status: "upload_requested",
        uploadRequestedAt: new Date(),
      });
      await pushConfig(
        { ...BASE, watch_directory: "/data/elsewhere" },
        { based_on_revision: 1 }
      );
      const [file] = await db()
        .select({ status: files.status })
        .from(files)
        .where(eq(files.instrumentRunId, run.id));
      expect(file.status).toBe("detected");
      await db().delete(files).where(eq(files.instrumentRunId, run.id));
      await db().delete(instrumentRuns).where(eq(instrumentRuns.id, run.id));
    });
  });

  // -------------------------------------------------------------------------
  // Preview
  // -------------------------------------------------------------------------

  describe("POST /config-preview", () => {
    beforeAll(async () => {
      const [run] = await db()
        .insert(instrumentRuns)
        .values({ instrumentId: INSTRUMENT_ID, runId: "PLATE1" })
        .returning({ id: instrumentRuns.id });
      await db()
        .insert(files)
        .values([
          {
            instrumentRunId: run.id,
            filename: "PLATE1_read.csv",
            relativePath: "PLATE1_read.csv",
            status: "uploaded",
          },
          {
            instrumentRunId: run.id,
            filename: "PLATE1_read.AZE",
            relativePath: "PLATE1_read.AZE",
            status: "uploaded",
          },
          {
            instrumentRunId: run.id,
            filename: "nested.csv",
            relativePath: "sub/nested.csv",
            status: "uploaded",
          },
        ]);
    });

    async function preview(
      settings: WatcherConfigSettings,
      cookie = adminCookie
    ) {
      return await api(`${base()}/config-preview`, {
        method: "POST",
        headers: { Cookie: cookie },
        body: { settings },
      });
    }

    it("shows which recent files match and their run IDs", async () => {
      const res = await preview({ ...BASE, file_patterns: ["*.csv", "*.AZE"] });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.sample_size).toBe(3);
      const byPath = Object.fromEntries(
        body.files.map((f: { relative_path: string }) => [f.relative_path, f])
      );
      expect(byPath["PLATE1_read.csv"]).toMatchObject({
        matches: true,
        run_id: "PLATE1",
      });
      expect(byPath["PLATE1_read.AZE"]).toMatchObject({
        matches: true,
        run_id: "PLATE1",
      });
      // Not recursive, so the nested file isn't seen.
      expect(byPath["sub/nested.csv"]).toMatchObject({
        matches: false,
        run_id: null,
      });
    });

    it("is for admins only", async () => {
      expect((await preview(BASE, memberCookie)).status).toBe(403);
      const call = async (token: string) =>
        await api(`${base()}/config-preview`, {
          method: "POST",
          token,
          body: { settings: BASE },
        });
      expect((await call(adminScopeToken)).status).toBe(200);
      expect((await call(legacyWriteToken)).status).toBe(403);
      expect((await call(wildcardToken)).status).toBe(403);
    });
  });

  it("exposes the revision numbers on the watcher list", async () => {
    await pushConfig(BASE);
    await saveFromWeb({ ...BASE, upload_mode: "manual" }, 1);
    const res = await api(`/api/v1/watchers?instrument_id=${INSTRUMENT_ID}`, {
      token: readOnlyToken,
    });
    const [row] = (await res.json()).data;
    expect(row).toMatchObject({
      config_revision: 2,
      applied_config_revision: 1,
      status_reason: null,
    });
    const [check] = await db()
      .select({ status: watcherConfigRevisions.status })
      .from(watcherConfigRevisions)
      .where(
        and(
          eq(watcherConfigRevisions.watcherId, watcherId),
          eq(watcherConfigRevisions.revision, 2)
        )
      );
    expect(check.status).toBe("pending");
  });
});
