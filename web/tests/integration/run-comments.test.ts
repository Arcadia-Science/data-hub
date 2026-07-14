import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  commentDeleted,
  commentsListResponse,
  runComment,
} from "@/lib/api/openapi";
import { instruments } from "@/lib/db/schema";
import {
  api,
  closeTestDb,
  getTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";

// End-to-end tests for the run comments surface:
//
//   - GET/POST /api/v1/instruments/:instrumentId/runs/:runId/comments
//   - PATCH/DELETE /api/v1/instruments/:instrumentId/runs/:runId/comments/:id
//
// Comments are markdown-bodied notes. Reads are open to any authenticated
// user; mutations are author-only (enforced both in the SQL `where` clause
// and in the route handler so we can return clean 403/404 distinctions).
describe("Run Comments API", () => {
  let tokenA: string;
  let userIdA: string;
  let tokenB: string;

  const instrumentId = "comments-test-instrument";

  beforeAll(async () => {
    await resetDb();

    ({ token: tokenA, userId: userIdA } = await seedTestUser());
    ({ token: tokenB } = await seedTestUser());

    const db = getTestDb();
    await db.insert(instruments).values({
      id: instrumentId,
      displayName: "Comments Test Instrument",
      status: "active",
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  async function createRun(runId: string): Promise<void> {
    const res = await api(`/api/v1/instruments/${instrumentId}/runs`, {
      method: "POST",
      token: tokenA,
      body: { run_id: runId, source: "lambda" },
    });
    expect([200, 201]).toContain(res.status);
  }

  function commentsPath(runId: string): string {
    return `/api/v1/instruments/${instrumentId}/runs/${runId}/comments`;
  }

  function commentPath(runId: string, commentId: string): string {
    return `${commentsPath(runId)}/${commentId}`;
  }

  async function postComment(
    runId: string,
    body: string,
    token: string
  ): Promise<{ id: string; body: string; edited_at: string | null }> {
    const res = await api(commentsPath(runId), {
      method: "POST",
      token,
      body: { body },
    });
    expect(res.status).toBe(201);
    return res.json();
  }

  // -------------------------------------------------------------------------
  // GET / POST collection endpoint
  // -------------------------------------------------------------------------

  it("GET without a token returns 401", async () => {
    const res = await api(commentsPath("nope"));
    expect(res.status).toBe(401);
  });

  it("GET on an unknown run returns 404 NOT_FOUND", async () => {
    const res = await api(commentsPath("does-not-exist"), { token: tokenA });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("POST creates a comment, GET returns it", async () => {
    const runId = "run-create-list";
    await createRun(runId);

    const created = await postComment(runId, "Hello **world**", tokenA);
    expect(created.id).toBeTruthy();
    expect(created.body).toBe("Hello **world**");
    expect(created.edited_at).toBeNull();
    // Drift guard: live responses must match their documented OpenAPI schemas
    // (responses aren't validated at runtime, so this is the only backstop).
    runComment.parse(created);

    const res = await api(commentsPath(runId), { token: tokenA });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.comments).toHaveLength(1);
    expect(body.comments[0].id).toBe(created.id);
    expect(body.comments[0].user.id).toBe(userIdA);
    expect(body.comments[0].user.displayName).toBeTruthy();
    expect(body.comments[0].user.initials).toBeTruthy();
    commentsListResponse.parse(body);
  });

  it("POST returns 400 for missing body field", async () => {
    const runId = "run-validate-missing";
    await createRun(runId);

    const res = await api(commentsPath(runId), {
      method: "POST",
      token: tokenA,
      body: {},
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("POST returns 400 for empty / whitespace-only body", async () => {
    const runId = "run-validate-empty";
    await createRun(runId);

    const res = await api(commentsPath(runId), {
      method: "POST",
      token: tokenA,
      body: { body: "   \n\t  " },
    });
    expect(res.status).toBe(400);
  });

  it("POST returns 400 for body > 10000 chars", async () => {
    const runId = "run-validate-toolong";
    await createRun(runId);

    const res = await api(commentsPath(runId), {
      method: "POST",
      token: tokenA,
      body: { body: "a".repeat(10_001) },
    });
    expect(res.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // PATCH / DELETE single-comment endpoint
  // -------------------------------------------------------------------------

  it("PATCH updates the body and sets edited_at", async () => {
    const runId = "run-patch-self";
    await createRun(runId);
    const created = await postComment(runId, "first draft", tokenA);

    const res = await api(commentPath(runId, created.id), {
      method: "PATCH",
      token: tokenA,
      body: { body: "second draft" },
    });
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.body).toBe("second draft");
    expect(updated.edited_at).toBeTruthy();
    runComment.parse(updated);
  });

  it("PATCH by another user returns 403 FORBIDDEN", async () => {
    const runId = "run-patch-other";
    await createRun(runId);
    const created = await postComment(runId, "owned by A", tokenA);

    const res = await api(commentPath(runId, created.id), {
      method: "PATCH",
      token: tokenB,
      body: { body: "tampered" },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("PATCH on an unknown comment id returns 404", async () => {
    const runId = "run-patch-missing";
    await createRun(runId);

    const res = await api(
      commentPath(runId, "00000000-0000-0000-0000-000000000000"),
      { method: "PATCH", token: tokenA, body: { body: "x" } }
    );
    expect(res.status).toBe(404);
  });

  it("DELETE soft-deletes; subsequent GET omits the comment", async () => {
    const runId = "run-delete-self";
    await createRun(runId);
    const created = await postComment(runId, "to be deleted", tokenA);

    const del = await api(commentPath(runId, created.id), {
      method: "DELETE",
      token: tokenA,
    });
    expect(del.status).toBe(200);
    commentDeleted.parse(await del.json());

    const list = await api(commentsPath(runId), { token: tokenA });
    const body = await list.json();
    expect(body.comments).toEqual([]);
  });

  it("DELETE by another user returns 403 FORBIDDEN", async () => {
    const runId = "run-delete-other";
    await createRun(runId);
    const created = await postComment(runId, "owned by A", tokenA);

    const res = await api(commentPath(runId, created.id), {
      method: "DELETE",
      token: tokenB,
    });
    expect(res.status).toBe(403);
  });

  // -------------------------------------------------------------------------
  // Soft-deleted run — all mutations rejected with 409
  // -------------------------------------------------------------------------

  it("POST on a soft-deleted run returns 409 CONFLICT", async () => {
    const runId = "run-deleted-post";
    await createRun(runId);
    // Soft-delete the run via the public API.
    const del = await api(`/api/v1/instruments/${instrumentId}/runs/${runId}`, {
      method: "DELETE",
      token: tokenA,
    });
    expect(del.status).toBe(200);

    const res = await api(commentsPath(runId), {
      method: "POST",
      token: tokenA,
      body: { body: "shouldn't work" },
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("CONFLICT");
  });

  it("PATCH/DELETE on a comment whose run is soft-deleted returns 409", async () => {
    const runId = "run-deleted-mutate";
    await createRun(runId);
    const created = await postComment(runId, "before deletion", tokenA);

    await api(`/api/v1/instruments/${instrumentId}/runs/${runId}`, {
      method: "DELETE",
      token: tokenA,
    });

    const patch = await api(commentPath(runId, created.id), {
      method: "PATCH",
      token: tokenA,
      body: { body: "edit" },
    });
    expect(patch.status).toBe(409);

    const del = await api(commentPath(runId, created.id), {
      method: "DELETE",
      token: tokenA,
    });
    expect(del.status).toBe(409);
  });

  // -------------------------------------------------------------------------
  // List ordering — oldest first (conversational reading order)
  // -------------------------------------------------------------------------

  it("GET returns comments ordered chronologically (oldest first)", async () => {
    const runId = "run-list-order";
    await createRun(runId);

    const c1 = await postComment(runId, "first", tokenA);
    // Tiny gap so created_at strictly differs across SQL clocks.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const c2 = await postComment(runId, "second", tokenB);

    const res = await api(commentsPath(runId), { token: tokenA });
    const body = await res.json();
    expect(body.comments).toHaveLength(2);
    expect(body.comments[0].id).toBe(c1.id);
    expect(body.comments[1].id).toBe(c2.id);
  });
});
