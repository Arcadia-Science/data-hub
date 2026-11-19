import type { AuthInfo, McpServer } from "@modelcontextprotocol/server";
import { notebookToWire, runOutcomesToWire } from "@/lib/api/notebook-wire";
import {
  ADD_RUN_OUTCOMES,
  addRunsToNotebook,
  createNotebook,
  deleteNotebook,
  getNotebook,
  listNotebooks,
  type NotebookError,
  REMOVE_RUN_OUTCOMES,
  type RunOutcomes,
  removeRunsFromNotebook,
  restoreNotebook,
  updateNotebook,
} from "@/lib/api/notebooks";
import { toolRegistrationConfig } from "@/lib/mcp/catalog/register";
import {
  errorResult,
  getMcpUserId,
  type McpErrorResult,
  requireMcpWrite,
  structuredResult,
} from "@/lib/mcp/tools/helpers";
import { blankToNull } from "@/lib/notebook-links/url";
import {
  addRunsToNotebookTool,
  createNotebookTool,
  deleteNotebookTool,
  getNotebookTool,
  listNotebooksTool,
  NOTEBOOKS_PER_PAGE_MCP_DEFAULT,
  removeRunsFromNotebookTool,
  restoreNotebookTool,
  updateNotebookTool,
} from "./notebooks.defs";

// Notebook writes act as the signed-in user, taken from the session and never
// from the arguments, the same way claims and comments are. Nothing sets an
// owner unless the caller passes one.

// Sentinel for `ownerId`: the signed-in user.
const OWNER_ME = "me";

const NO_USER = "Authenticated user not available on this session.";

type WriteUser =
  | { ok: true; userId: string }
  | { ok: false; error: McpErrorResult };

function writeUser(authInfo: AuthInfo | undefined): WriteUser {
  const writeError = requireMcpWrite(authInfo);
  if (writeError) {
    return { ok: false, error: writeError };
  }
  const userId = getMcpUserId(authInfo);
  if (!userId) {
    return { ok: false, error: errorResult(NO_USER) };
  }
  return { ok: true, userId };
}

// "me" becomes the signed-in user; null and undefined pass through.
function resolveOwner<T extends string | null | undefined>(
  ownerId: T,
  userId: string
): T | string {
  return ownerId === OWNER_ME ? userId : ownerId;
}

// A 409 for a page that already has a notebook names that notebook, so the
// assistant can add the runs to it instead.
function notebookError(
  error: NotebookError,
  nextStep?: (deleted: boolean) => string
) {
  const id = error.details?.notebook_id;
  if (typeof id !== "string") {
    return errorResult(error.message);
  }
  const next = nextStep ? ` ${nextStep(error.details?.deleted === true)}` : "";
  return errorResult(`${error.message} Notebook id: ${id}.${next}`);
}

function addRunsInstead(deleted: boolean): string {
  return deleted
    ? "Call restore_notebook, then add_runs_to_notebook."
    : "Add runs to it with add_runs_to_notebook.";
}

function runsToMcp<O extends string>(
  outcomes: readonly O[],
  instrumentId: string,
  result: RunOutcomes<O>
) {
  const wire = runOutcomesToWire(outcomes, result);
  return {
    notebookId: wire.notebook_id,
    instrumentId,
    results: wire.results.map((entry) => ({
      runId: entry.run_id,
      outcome: entry.outcome,
    })),
    counts: wire.counts,
  };
}

export function registerNotebookTools(server: McpServer) {
  server.registerTool(
    listNotebooksTool.name,
    toolRegistrationConfig(listNotebooksTool),
    async (args, ctx) => {
      let ownerId = args.ownerId;
      if (ownerId === OWNER_ME) {
        ownerId = getMcpUserId(ctx.http?.authInfo);
        if (!ownerId) {
          return errorResult(
            'ownerId="me" needs a signed-in user on this session. Pass a user id instead.'
          );
        }
      }
      const list = await listNotebooks({
        query: args.query,
        ownerId,
        includeDeleted: args.includeDeleted ?? false,
        sort: args.sort,
        order: args.order,
        page: args.page ?? 1,
        perPage: args.perPage ?? NOTEBOOKS_PER_PAGE_MCP_DEFAULT,
      });
      return structuredResult({
        data: list.notebooks.map(notebookToWire),
        pagination: {
          page: list.page,
          per_page: list.perPage,
          total: list.total,
          total_pages: Math.ceil(list.total / list.perPage),
        },
      });
    }
  );

  server.registerTool(
    getNotebookTool.name,
    toolRegistrationConfig(getNotebookTool),
    async ({ notebookId }) => {
      const notebook = await getNotebook(notebookId);
      if (!notebook) {
        return errorResult(`Notebook '${notebookId}' not found.`);
      }
      return structuredResult(notebookToWire(notebook));
    }
  );

  server.registerTool(
    createNotebookTool.name,
    toolRegistrationConfig(createNotebookTool),
    async (args, ctx) => {
      const user = writeUser(ctx.http?.authInfo);
      if (!user.ok) {
        return user.error;
      }
      const { instrumentId, runIds } = args;
      if (runIds && !instrumentId) {
        return errorResult("Pass instrumentId with runIds.");
      }

      const result = await createNotebook({
        url: args.url,
        name: args.name,
        description:
          args.description === undefined ? null : blankToNull(args.description),
        ownerId: resolveOwner(args.ownerId, user.userId) ?? null,
        runs:
          instrumentId && runIds
            ? runIds.map((runId) => ({ instrumentId, runId }))
            : undefined,
        actor: { kind: "user", userId: user.userId },
      });
      if (!result.ok) {
        return notebookError(result, addRunsInstead);
      }

      const { notebook, runs } = result.value;
      return structuredResult({
        notebook: notebookToWire(notebook),
        runs:
          runs && instrumentId
            ? runsToMcp(ADD_RUN_OUTCOMES, instrumentId, runs)
            : null,
      });
    }
  );

  server.registerTool(
    updateNotebookTool.name,
    toolRegistrationConfig(updateNotebookTool),
    async ({ notebookId, name, description, ownerId, url }, ctx) => {
      const user = writeUser(ctx.http?.authInfo);
      if (!user.ok) {
        return user.error;
      }
      if (
        name === undefined &&
        description === undefined &&
        ownerId === undefined &&
        url === undefined
      ) {
        return errorResult("Pass name, description, ownerId, or url.");
      }

      const result = await updateNotebook({
        id: notebookId,
        name,
        description:
          description === undefined || description === null
            ? description
            : blankToNull(description),
        ownerId: resolveOwner(ownerId, user.userId),
        url,
        actor: { kind: "user", userId: user.userId },
      });
      if (!result.ok) {
        return notebookError(result);
      }
      return structuredResult(notebookToWire(result.value));
    }
  );

  server.registerTool(
    deleteNotebookTool.name,
    toolRegistrationConfig(deleteNotebookTool),
    async ({ notebookId }, ctx) => {
      const user = writeUser(ctx.http?.authInfo);
      if (!user.ok) {
        return user.error;
      }
      const result = await deleteNotebook({
        id: notebookId,
        actor: { kind: "user", userId: user.userId },
      });
      if (!result.ok) {
        return notebookError(result);
      }
      return structuredResult(notebookToWire(result.value));
    }
  );

  server.registerTool(
    restoreNotebookTool.name,
    toolRegistrationConfig(restoreNotebookTool),
    async ({ notebookId }, ctx) => {
      const user = writeUser(ctx.http?.authInfo);
      if (!user.ok) {
        return user.error;
      }
      const result = await restoreNotebook({
        id: notebookId,
        actor: { kind: "user", userId: user.userId },
      });
      if (!result.ok) {
        return notebookError(result);
      }
      return structuredResult(notebookToWire(result.value));
    }
  );

  server.registerTool(
    addRunsToNotebookTool.name,
    toolRegistrationConfig(addRunsToNotebookTool),
    async ({ notebookId, instrumentId, runIds }, ctx) => {
      const user = writeUser(ctx.http?.authInfo);
      if (!user.ok) {
        return user.error;
      }
      const result = await addRunsToNotebook({
        notebookId,
        runs: runIds.map((runId) => ({ instrumentId, runId })),
        actor: { kind: "user", userId: user.userId },
      });
      if (!result.ok) {
        return notebookError(result);
      }
      return structuredResult(
        runsToMcp(ADD_RUN_OUTCOMES, instrumentId, result.value)
      );
    }
  );

  server.registerTool(
    removeRunsFromNotebookTool.name,
    toolRegistrationConfig(removeRunsFromNotebookTool),
    async ({ notebookId, instrumentId, runIds }, ctx) => {
      const writeError = requireMcpWrite(ctx.http?.authInfo);
      if (writeError) {
        return writeError;
      }
      const result = await removeRunsFromNotebook({
        notebookId,
        runs: runIds.map((runId) => ({ instrumentId, runId })),
      });
      if (!result.ok) {
        return notebookError(result);
      }
      return structuredResult(
        runsToMcp(REMOVE_RUN_OUTCOMES, instrumentId, result.value)
      );
    }
  );
}
