import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  commentDeleted,
  commentsListResponse,
  runComment,
} from "@/lib/api/openapi";
import { commentDeleterFor, softDeleteComment } from "@/lib/api/run-comments";
import { instruments, runComments, users } from "@/lib/db/schema";
import {
  api,
  closeTestDb,
  getTestDb,
  resetDb,
  seedSessionCookie,
  seedTestUser,
} from "@/tests/integration/helpers";

// End-to-end tests for the run comments surface:
//
//   - GET/POST /api/v1/instruments/:instrumentId/runs/:runId/comments
//   - PATCH/DELETE /api/v1/instruments/:instrumentId/runs/:runId/comments/:id
//
// Comments are markdown-bodied notes. Reads are open to any authenticated
// caller. Edit is author-only; delete is for the author or a signed-in admin,
// and the admin path is not pinned to the author in SQL. Both are checked in
// the route handler too, so we can return clean 403/404 distinctions. A
// comment posted with a personal access token is authored by the token, so
// only that token can edit it, and only that token or an admin can delete it.
describe("Run Comments API", () => {
  let tokenA: string;
  let tokenIdA: string;
  let userIdA: string;
  let tokenB: string;

  const instrumentId = "comments-test-instrument";

  beforeAll(async () => {
    await resetDb();

    ({
      token: tokenA,
      tokenId: tokenIdA,
      userId: userIdA,
    } = await seedTestUser({ tokenName: "Comment Bot A" }));
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
    // A token-authored comment names the token and has no user.
    expect(body.comments[0].user).toBeNull();
    expect(body.comments[0].token).toEqual({
      id: tokenIdA,
      name: "Comment Bot A",
    });
    commentsListResponse.parse(body);
  });

  it("a comment posted from a browser session names the user", async () => {
    const runId = "run-session-author";
    await createRun(runId);
    const cookie = await seedSessionCookie(userIdA);

    const res = await api(commentsPath(runId), {
      method: "POST",
      headers: { Cookie: cookie },
      body: { body: "from the browser" },
    });
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.user.id).toBe(userIdA);
    expect(created.user.displayName).toBeTruthy();
    expect(created.token).toBeNull();
    runComment.parse(created);
  });

  it("a token cannot edit or delete a comment written by a person", async () => {
    const runId = "run-person-comment";
    await createRun(runId);
    const cookie = await seedSessionCookie(userIdA);
    const posted = await api(commentsPath(runId), {
      method: "POST",
      headers: { Cookie: cookie },
      body: { body: "written by a person" },
    });
    const created = (await posted.json()) as { id: string };

    // Even the token created by the same person is a different author.
    const patch = await api(commentPath(runId, created.id), {
      method: "PATCH",
      token: tokenA,
      body: { body: "tampered" },
    });
    expect(patch.status).toBe(403);
    const del = await api(commentPath(runId, created.id), {
      method: "DELETE",
      token: tokenA,
    });
    expect(del.status).toBe(403);
  });

  it("a person cannot edit a comment written by a token", async () => {
    const runId = "run-token-comment";
    await createRun(runId);
    const created = await postComment(runId, "written by a token", tokenA);
    const cookie = await seedSessionCookie(userIdA);

    const patch = await api(commentPath(runId, created.id), {
      method: "PATCH",
      headers: { Cookie: cookie },
      body: { body: "tampered" },
    });
    expect(patch.status).toBe(403);
  });

  it("run list comment_count includes active comments only", async () => {
    const runId = "run-list-comment-count";
    await createRun(runId);
    await postComment(runId, "first", tokenA);
    const second = await postComment(runId, "second", tokenA);

    const listed = await api(`/api/v1/instruments/${instrumentId}/runs`, {
      token: tokenA,
    });
    expect(listed.status).toBe(200);
    const body = await listed.json();
    const row = body.data.find((r: { run_id: string }) => r.run_id === runId);
    expect(row?.comment_count).toBe(2);

    const del = await api(commentPath(runId, second.id), {
      method: "DELETE",
      token: tokenA,
    });
    expect(del.status).toBe(200);

    const listedAfter = await api(`/api/v1/instruments/${instrumentId}/runs`, {
      token: tokenA,
    });
    const afterBody = await listedAfter.json();
    const afterRow = afterBody.data.find(
      (r: { run_id: string }) => r.run_id === runId
    );
    expect(afterRow?.comment_count).toBe(1);
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

// Admins can delete any comment, but never edit one. The deleter is recorded
// on the row: a person's id for every person-made delete, nothing when a
// token deletes its own comment.
describe("Run Comments API — deletion by admins", () => {
  let tokenA: string;
  let tokenIdOther: string;
  let adminId: string;
  let memberId: string;
  let authorId: string;

  const instrumentId = "comments-admin-test-instrument";

  beforeAll(async () => {
    await resetDb();
    ({ token: tokenA } = await seedTestUser());
    ({ tokenId: tokenIdOther } = await seedTestUser());
    ({ userId: adminId } = await seedTestUser({ isAdmin: true }));
    ({ userId: memberId } = await seedTestUser());
    ({ userId: authorId } = await seedTestUser());

    await getTestDb().insert(instruments).values({
      id: instrumentId,
      displayName: "Comments Admin Test Instrument",
      status: "active",
    });
  });

  function commentsPath(runId: string): string {
    return `/api/v1/instruments/${instrumentId}/runs/${runId}/comments`;
  }

  async function createRun(runId: string): Promise<void> {
    const res = await api(`/api/v1/instruments/${instrumentId}/runs`, {
      method: "POST",
      token: tokenA,
      body: { run_id: runId, source: "lambda" },
    });
    expect([200, 201]).toContain(res.status);
  }

  async function postAsPerson(
    runId: string,
    userId: string,
    body: string
  ): Promise<string> {
    const res = await api(commentsPath(runId), {
      method: "POST",
      headers: { Cookie: await seedSessionCookie(userId) },
      body: { body },
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  async function postAsToken(runId: string, body: string): Promise<string> {
    const res = await api(commentsPath(runId), {
      method: "POST",
      token: tokenA,
      body: { body },
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  async function deleteAs(
    runId: string,
    commentId: string,
    userId: string
  ): Promise<Response> {
    return await api(`${commentsPath(runId)}/${commentId}`, {
      method: "DELETE",
      headers: { Cookie: await seedSessionCookie(userId) },
    });
  }

  async function readDeleter(commentId: string) {
    const [row] = await getTestDb()
      .select({
        deletedAt: runComments.deletedAt,
        deletedBy: runComments.deletedBy,
      })
      .from(runComments)
      .where(eq(runComments.id, commentId));
    return row;
  }

  it("lets an admin delete a member's comment and records the admin", async () => {
    const runId = "admin-deletes-member";
    await createRun(runId);
    const commentId = await postAsPerson(runId, authorId, "from a member");

    const res = await deleteAs(runId, commentId, adminId);
    expect(res.status).toBe(200);

    const row = await readDeleter(commentId);
    expect(row.deletedAt).toBeInstanceOf(Date);
    expect(row.deletedBy).toBe(adminId);
  });

  it("lets an admin delete a comment a token posted", async () => {
    const runId = "admin-deletes-token-comment";
    await createRun(runId);
    const commentId = await postAsToken(runId, "from a token");

    const res = await deleteAs(runId, commentId, adminId);
    expect(res.status).toBe(200);
    expect((await readDeleter(commentId)).deletedBy).toBe(adminId);
  });

  it("does not let a member delete someone else's comment", async () => {
    const runId = "member-cannot-delete";
    await createRun(runId);
    const commentId = await postAsPerson(runId, authorId, "from the author");

    const res = await deleteAs(runId, commentId, memberId);
    expect(res.status).toBe(403);
    expect((await readDeleter(commentId)).deletedAt).toBeNull();
  });

  it("does not let an admin edit someone else's comment", async () => {
    const runId = "admin-cannot-edit";
    await createRun(runId);
    const commentId = await postAsPerson(runId, authorId, "original");

    const res = await api(`${commentsPath(runId)}/${commentId}`, {
      method: "PATCH",
      headers: { Cookie: await seedSessionCookie(adminId) },
      body: { body: "reworded" },
    });
    expect(res.status).toBe(403);
  });

  it("records the author when they delete their own comment", async () => {
    const runId = "author-deletes-own";
    await createRun(runId);
    const commentId = await postAsPerson(runId, authorId, "mine");

    expect((await deleteAs(runId, commentId, authorId)).status).toBe(200);
    expect((await readDeleter(commentId)).deletedBy).toBe(authorId);
  });

  it("records no deleter when a token deletes its own comment", async () => {
    const runId = "token-deletes-own";
    await createRun(runId);
    const commentId = await postAsToken(runId, "mine");

    const res = await api(`${commentsPath(runId)}/${commentId}`, {
      method: "DELETE",
      token: tokenA,
    });
    expect(res.status).toBe(200);
    const row = await readDeleter(commentId);
    expect(row.deletedAt).toBeInstanceOf(Date);
    expect(row.deletedBy).toBeNull();
  });

  it("never lets a token delete a person's comment, even an admin's token", async () => {
    const runId = "token-cannot-delete-person";
    await createRun(runId);
    const commentId = await postAsPerson(runId, authorId, "from a person");
    const adminToken = await seedTestUser({ isAdmin: true });

    const res = await api(`${commentsPath(runId)}/${commentId}`, {
      method: "DELETE",
      token: adminToken.token,
    });
    expect(res.status).toBe(403);
    expect((await readDeleter(commentId)).deletedAt).toBeNull();
  });

  it("refuses an admin whose role was removed", async () => {
    const runId = "demoted-admin";
    await createRun(runId);
    const commentId = await postAsPerson(runId, authorId, "from a member");
    const { userId: demotedId } = await seedTestUser({ isAdmin: true });
    const cookie = await seedSessionCookie(demotedId);

    await getTestDb()
      .update(users)
      .set({ isAdmin: false })
      .where(eq(users.id, demotedId));

    // `seedSessionCookie` sets only the session token, not the cached session
    // cookie a browser would still hold. So the role comes from the database,
    // and the 403 proves the route checks it there.
    const res = await api(`${commentsPath(runId)}/${commentId}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(403);
    expect((await readDeleter(commentId)).deletedAt).toBeNull();
  });

  it("does not let one token delete another token's comment", async () => {
    const runId = "token-vs-token";
    await createRun(runId);
    const commentId = await postAsToken(runId, "from token A");
    const other = await seedTestUser();

    const res = await api(`${commentsPath(runId)}/${commentId}`, {
      method: "DELETE",
      token: other.token,
    });
    expect(res.status).toBe(403);
    expect((await readDeleter(commentId)).deletedAt).toBeNull();
  });

  it("returns 404 when the comment belongs to a different run", async () => {
    await createRun("run-with-comment");
    await createRun("run-without-comment");
    const commentId = await postAsPerson(
      "run-with-comment",
      authorId,
      "on the first run"
    );

    const res = await deleteAs("run-without-comment", commentId, adminId);
    expect(res.status).toBe(404);
    expect((await readDeleter(commentId)).deletedAt).toBeNull();
  });

  it("returns 409 when an admin deletes on a soft-deleted run", async () => {
    const runId = "admin-deleted-run";
    await createRun(runId);
    const commentId = await postAsPerson(runId, authorId, "before the delete");
    const del = await api(`/api/v1/instruments/${instrumentId}/runs/${runId}`, {
      method: "DELETE",
      token: tokenA,
    });
    expect(del.status).toBe(200);

    const res = await deleteAs(runId, commentId, adminId);
    expect(res.status).toBe(409);
    expect((await readDeleter(commentId)).deletedAt).toBeNull();
  });

  // The shared rule behind both REST and MCP. These call the library
  // directly so the token case is covered without an HTTP session.
  describe("commentDeleterFor and softDeleteComment", () => {
    it("picks the author, an admin, or nobody", async () => {
      const comment = { userId: authorId, tokenId: null };

      expect(
        await commentDeleterFor(comment, { kind: "user", userId: authorId })
      ).toEqual({
        as: "author",
        actor: { kind: "user", userId: authorId },
      });
      expect(
        await commentDeleterFor(comment, { kind: "user", userId: adminId })
      ).toEqual({ as: "admin", adminUserId: adminId });
      expect(
        await commentDeleterFor(comment, { kind: "user", userId: memberId })
      ).toBeNull();
    });

    it("never returns an admin deleter for a token", async () => {
      // This token was created by an admin, but a token is never an admin.
      const adminsToken = await seedTestUser({ isAdmin: true });
      const tokenActor = {
        kind: "token" as const,
        tokenId: adminsToken.tokenId,
        tokenName: "admin's token",
      };

      expect(
        await commentDeleterFor({ userId: authorId, tokenId: null }, tokenActor)
      ).toBeNull();
      expect(
        await commentDeleterFor(
          { userId: null, tokenId: tokenIdOther },
          tokenActor
        )
      ).toBeNull();
      expect(
        await commentDeleterFor(
          { userId: null, tokenId: adminsToken.tokenId },
          tokenActor
        )
      ).toEqual({ as: "author", actor: tokenActor });
    });

    it("checks the admin flag in SQL, not only in the caller", async () => {
      const runId = "sql-admin-guard";
      await createRun(runId);
      const commentId = await postAsPerson(runId, authorId, "from the author");

      // A caller that skipped `commentDeleterFor` and claimed admin for a
      // member still deletes nothing.
      expect(
        await softDeleteComment(commentId, {
          as: "admin",
          adminUserId: memberId,
        })
      ).toBe(false);
      expect((await readDeleter(commentId)).deletedAt).toBeNull();

      expect(
        await softDeleteComment(commentId, {
          as: "admin",
          adminUserId: adminId,
        })
      ).toBe(true);
      expect((await readDeleter(commentId)).deletedBy).toBe(adminId);
    });
  });
});
