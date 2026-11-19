import type { NextRequest } from "next/server";
import { surfaceEvent, trackEvent } from "@/lib/analytics/track";
import { actorRefFromAuth } from "@/lib/api/actor";
import { authorize } from "@/lib/api/auth";
import {
  apiError,
  apiErrorFromResult,
  VALIDATION_ERROR,
} from "@/lib/api/errors";
import {
  ownerFromBody,
  runKeysFromBody,
  WATCHER_TOKEN_NOTEBOOK_REFUSAL,
} from "@/lib/api/notebook-routes";
import { notebookToWire, runOutcomesToWire } from "@/lib/api/notebook-wire";
import {
  ADD_RUN_OUTCOMES,
  createNotebook,
  listNotebooks,
  NOTEBOOK_SORTS,
  NOTEBOOKS_PER_PAGE_DEFAULT,
  NOTEBOOKS_PER_PAGE_MAX,
  type NotebookSort,
} from "@/lib/api/notebooks";
import { createNotebookBody, readJsonBody } from "@/lib/api/openapi";
import { parseIntParam } from "@/lib/api/validators";
import { refuseWatcherTokenAdmin } from "@/lib/api/watchers";
import { blankToNull } from "@/lib/notebook-links/url";

function isNotebookSort(value: string): value is NotebookSort {
  return (NOTEBOOK_SORTS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// GET /api/v1/notebooks
//
// Lab notebooks, a page at a time. `q` matches text in a name, description,
// or link; a pasted link matches only the notebook for that page. Deleted
// notebooks are left out unless `include_deleted=true`.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const authResult = await authorize(request, "runs:read");
  if (authResult instanceof Response) {
    return authResult;
  }

  const { searchParams } = request.nextUrl;
  // A blank `sort` or `order` means the default.
  const sort = searchParams.get("sort") || undefined;
  if (sort !== undefined && !isNotebookSort(sort)) {
    return apiError(
      400,
      VALIDATION_ERROR,
      `Invalid sort '${sort}'. Use one of: ${NOTEBOOK_SORTS.join(", ")}.`
    );
  }
  const order = searchParams.get("order") || undefined;
  if (order !== undefined && order !== "asc" && order !== "desc") {
    return apiError(
      400,
      VALIDATION_ERROR,
      `Invalid order '${order}'. Use asc or desc.`
    );
  }

  const result = await listNotebooks({
    query: searchParams.get("q") ?? undefined,
    ownerId: searchParams.get("owner_id")?.trim() || undefined,
    includeDeleted: searchParams.get("include_deleted") === "true",
    sort,
    order,
    page: parseIntParam(searchParams.get("page"), { default: 1, min: 1 }),
    perPage: parseIntParam(searchParams.get("per_page"), {
      default: NOTEBOOKS_PER_PAGE_DEFAULT,
      min: 1,
      max: NOTEBOOKS_PER_PAGE_MAX,
    }),
  });

  return Response.json({
    data: result.notebooks.map(notebookToWire),
    pagination: {
      page: result.page,
      per_page: result.perPage,
      total: result.total,
      total_pages: Math.ceil(result.total / result.perPage),
    },
  });
}

// ---------------------------------------------------------------------------
// POST /api/v1/notebooks
//
// Create a notebook for a page. Body: { url, name, description?, owner_id?,
// runs? }. Runs given here are added in the same transaction, with an
// outcome for each. 409 when another notebook, deleted or not, already has
// the page: `details.notebook_id` names it and `details.deleted` says whether
// it is deleted.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const authResult = await authorize(request, "notebooks:write");
  if (authResult instanceof Response) {
    return authResult;
  }

  const refused = await refuseWatcherTokenAdmin(
    authResult,
    WATCHER_TOKEN_NOTEBOOK_REFUSAL
  );
  if (refused) {
    return refused;
  }

  const payload = await readJsonBody(request, createNotebookBody);
  if (payload instanceof Response) {
    return payload;
  }

  const ownerId = ownerFromBody(authResult, payload.owner_id ?? null);
  if (ownerId instanceof Response) {
    return ownerId;
  }

  const result = await createNotebook({
    url: payload.url,
    name: payload.name,
    description: blankToNull(payload.description ?? ""),
    ownerId,
    runs: payload.runs ? runKeysFromBody(payload.runs) : undefined,
    actor: actorRefFromAuth(authResult),
  });
  if (!result.ok) {
    return apiErrorFromResult(result);
  }

  const runs = result.value.runs
    ? runOutcomesToWire(ADD_RUN_OUTCOMES, result.value.runs)
    : null;
  trackEvent("notebook_created", {
    ...surfaceEvent(authResult),
    runs: runs?.counts.added ?? 0,
  });

  return Response.json(
    { notebook: notebookToWire(result.value.notebook), runs },
    { status: 201 }
  );
}
