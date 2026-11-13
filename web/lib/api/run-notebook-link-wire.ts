import type { Actor } from "@/lib/api/actor";
import type {
  BulkAddOutcome,
  BulkAddResult,
  BulkRemoveOutcome,
  BulkRemoveResult,
  NotebookLinkDto,
} from "@/lib/api/run-notebook-links";

// The REST shape of a lab notebook link. People and tokens sit in separate
// fields, the way run comments report their author. The browser reads the
// same shape, so this module has no server imports.

export interface NotebookLinkWireUser {
  avatarUrl: string | null;
  displayName: string;
  id: string;
  initials: string;
}

export interface NotebookLinkWire {
  created_at: string;
  created_by: NotebookLinkWireUser | null;
  created_by_token: { id: string; name: string } | null;
  display_name: string;
  id: string;
  label: string | null;
  updated_at: string;
  updated_by: NotebookLinkWireUser | null;
  updated_by_token: { id: string; name: string } | null;
  url: string;
  url_key: string;
}

function wireUser(actor: Actor | null): NotebookLinkWireUser | null {
  return actor?.kind === "user"
    ? {
        id: actor.user.userId,
        displayName: actor.user.displayName,
        initials: actor.user.initials,
        avatarUrl: actor.user.avatarUrl,
      }
    : null;
}

function wireToken(actor: Actor | null): { id: string; name: string } | null {
  return actor?.kind === "token"
    ? { id: actor.token.id, name: actor.token.name }
    : null;
}

export function notebookLinkToWire(link: NotebookLinkDto): NotebookLinkWire {
  return {
    id: link.id,
    url: link.url,
    url_key: link.urlKey,
    label: link.label,
    display_name: link.displayName,
    created_at: link.createdAt.toISOString(),
    created_by: wireUser(link.createdBy),
    created_by_token: wireToken(link.createdBy),
    updated_at: link.updatedAt.toISOString(),
    updated_by: wireUser(link.updatedBy),
    updated_by_token: wireToken(link.updatedBy),
  };
}

const BULK_ADD_OUTCOMES: readonly BulkAddOutcome[] = [
  "added",
  "already_linked",
  "run_deleted",
  "limit_reached",
  "not_found",
];

const BULK_REMOVE_OUTCOMES: readonly BulkRemoveOutcome[] = [
  "removed",
  "not_linked",
  "run_deleted",
  "not_found",
];

function countOutcomes<O extends string>(
  outcomes: readonly O[],
  results: ReadonlyArray<{ outcome: O }>
): Record<O, number> {
  const counts = Object.fromEntries(outcomes.map((o) => [o, 0])) as Record<
    O,
    number
  >;
  for (const result of results) {
    counts[result.outcome] += 1;
  }
  return counts;
}

export interface BulkAddNotebookLinkWire {
  counts: Record<BulkAddOutcome, number>;
  results: Array<{
    instrument_id: string;
    link: NotebookLinkWire | null;
    outcome: BulkAddOutcome;
    run_id: string;
  }>;
  url: string;
  url_key: string;
}

export function bulkAddResultToWire(
  result: BulkAddResult
): BulkAddNotebookLinkWire {
  return {
    url: result.url,
    url_key: result.urlKey,
    results: result.results.map((entry) => ({
      instrument_id: entry.instrumentId,
      run_id: entry.runId,
      outcome: entry.outcome,
      link: entry.link ? notebookLinkToWire(entry.link) : null,
    })),
    counts: countOutcomes(BULK_ADD_OUTCOMES, result.results),
  };
}

export interface BulkRemoveNotebookLinksWire {
  counts: Record<BulkRemoveOutcome, number>;
  results: Array<{
    instrument_id: string;
    outcome: BulkRemoveOutcome;
    removed: number;
    run_id: string;
  }>;
  url_keys: string[];
}

export function bulkRemoveResultToWire(
  result: BulkRemoveResult
): BulkRemoveNotebookLinksWire {
  return {
    url_keys: result.urlKeys,
    results: result.results.map((entry) => ({
      instrument_id: entry.instrumentId,
      run_id: entry.runId,
      outcome: entry.outcome,
      removed: entry.removed,
    })),
    counts: countOutcomes(BULK_REMOVE_OUTCOMES, result.results),
  };
}

/** Who added a link, as the UI's actor labels expect it. */
export function notebookLinkCreator(link: NotebookLinkWire): Actor | null {
  if (link.created_by) {
    return {
      kind: "user",
      user: {
        userId: link.created_by.id,
        displayName: link.created_by.displayName,
        initials: link.created_by.initials,
        avatarUrl: link.created_by.avatarUrl,
      },
    };
  }
  if (link.created_by_token) {
    // The wire has no revoked flag, so a token reads as active.
    return {
      kind: "token",
      token: { ...link.created_by_token, revoked: false },
    };
  }
  return null;
}
