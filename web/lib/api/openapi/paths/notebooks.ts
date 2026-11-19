import { z } from "zod";
import {
  bearerSecurity,
  errorResponses,
  jsonResponse,
  notebookIdParam,
  registry,
} from "../registry";
import {
  createNotebookBody,
  notebook,
  notebookCreated,
  notebookListQuery,
  notebookListResponse,
  notebookRunsAdded,
  notebookRunsBody,
  notebookRunsRemoved,
  updateNotebookBody,
} from "../schemas/notebooks";

const notebookParams = z.object({ notebookId: notebookIdParam });
const tag = ["Notebooks"];
const scoped = (scope: string) => `Requires scope \`${scope}\`.`;
const body = (schema: z.ZodType) => ({
  content: { "application/json": { schema } },
});
const ok = (description: string, schema: z.ZodType) => ({
  200: jsonResponse(description, schema),
  ...errorResponses(),
});

// See `refuseWatcherTokenAdmin`. The watcher never manages notebooks.
const WATCHER_TOKEN_REFUSED =
  "A token that registered a watcher gets 403. It may only add its own instrument's runs to a notebook and remove them.";
// See `enforceWatcherTokenInstrument`.
const WATCHER_TOKEN_OWN_RUNS =
  "A token that registered a watcher gets 403 for the whole request when any listed run is on an instrument whose active watcher it didn't register.";
const PAGE_TAKEN =
  "Returns 409 when another notebook already has the page, deleted ones included: `details.notebook_id` names that notebook and `details.deleted` says whether it is deleted. Restore a deleted one instead.";

registry.registerPath({
  method: "get",
  path: "/notebooks",
  operationId: "listNotebooks",
  summary: "List lab notebooks",
  description: `${scoped("runs:read")} To list a notebook's runs, filter a run list by \`notebook_id\`.`,
  tags: tag,
  security: bearerSecurity,
  request: { query: notebookListQuery },
  responses: ok("Paginated notebooks.", notebookListResponse),
});
registry.registerPath({
  method: "post",
  path: "/notebooks",
  operationId: "createNotebook",
  summary: "Create a lab notebook",
  description: `${scoped("notebooks:write")} A notebook is one page, such as a Notion page. Send \`runs\` to add runs in the same request; each one gets its own outcome, as in \`POST /notebooks/{notebookId}/runs\`. ${PAGE_TAKEN} Returns 400 when \`owner_id\` names no user. ${WATCHER_TOKEN_REFUSED}`,
  tags: tag,
  security: bearerSecurity,
  request: { body: body(createNotebookBody) },
  responses: {
    201: jsonResponse("Created notebook.", notebookCreated),
    ...errorResponses(),
  },
});
registry.registerPath({
  method: "get",
  path: "/notebooks/{notebookId}",
  operationId: "getNotebook",
  summary: "Get a lab notebook",
  description: `${scoped("runs:read")} Deleted notebooks are returned too, with \`deleted_at\` set.`,
  tags: tag,
  security: bearerSecurity,
  request: { params: notebookParams },
  responses: ok("Notebook.", notebook),
});
registry.registerPath({
  method: "patch",
  path: "/notebooks/{notebookId}",
  operationId: "updateNotebook",
  summary: "Edit a lab notebook",
  description: `${scoped("notebooks:write")} Fields left out stay as they are. ${PAGE_TAKEN} Returns 400 when \`owner_id\` names no user, and 409 when the notebook is deleted. ${WATCHER_TOKEN_REFUSED}`,
  tags: tag,
  security: bearerSecurity,
  request: { params: notebookParams, body: body(updateNotebookBody) },
  responses: ok("Updated notebook.", notebook),
});
registry.registerPath({
  method: "delete",
  path: "/notebooks/{notebookId}",
  operationId: "deleteNotebook",
  summary: "Delete a lab notebook",
  description: `${scoped("notebooks:write")} Marks the notebook deleted. Its runs keep their place in it, so restoring the notebook brings them back. Until then, runs don't list it and \`has_notebook\` doesn't count it. Returns 409 when it is already deleted. ${WATCHER_TOKEN_REFUSED}`,
  tags: tag,
  security: bearerSecurity,
  request: { params: notebookParams },
  responses: ok("Deleted notebook.", notebook),
});
registry.registerPath({
  method: "post",
  path: "/notebooks/{notebookId}/restore",
  operationId: "restoreNotebook",
  summary: "Restore a lab notebook",
  description: `${scoped("notebooks:write")} Brings back a deleted notebook with the runs it had. Returns 409 when it isn't deleted. ${WATCHER_TOKEN_REFUSED}`,
  tags: tag,
  security: bearerSecurity,
  request: { params: notebookParams },
  responses: ok("Restored notebook.", notebook),
});
registry.registerPath({
  method: "post",
  path: "/notebooks/{notebookId}/runs",
  operationId: "addRunsToNotebook",
  summary: "Add runs to a lab notebook",
  description: `${scoped("notebooks:write")} Reports an outcome for each run instead of failing the whole request. Runs already in the notebook stay as they are. Returns 409 when the notebook is deleted. ${WATCHER_TOKEN_OWN_RUNS}`,
  tags: tag,
  security: bearerSecurity,
  request: { params: notebookParams, body: body(notebookRunsBody) },
  responses: ok("Outcome for each run.", notebookRunsAdded),
});
registry.registerPath({
  method: "post",
  path: "/notebooks/{notebookId}/runs/remove",
  operationId: "removeRunsFromNotebook",
  summary: "Remove runs from a lab notebook",
  description: `${scoped("notebooks:write")} Reports an outcome for each run instead of failing the whole request. The notebook stays, even with no runs left. Returns 409 when the notebook is deleted. A POST rather than a DELETE with a body, which some proxies and clients drop. ${WATCHER_TOKEN_OWN_RUNS}`,
  tags: tag,
  security: bearerSecurity,
  request: { params: notebookParams, body: body(notebookRunsBody) },
  responses: ok("Outcome for each run.", notebookRunsRemoved),
});
