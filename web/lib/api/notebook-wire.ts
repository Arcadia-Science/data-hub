import type { Actor } from "@/lib/api/actor";
import type {
  AddRunOutcome,
  NotebookDto,
  RemoveRunOutcome,
  RunNotebookDto,
  RunOutcomes,
} from "@/lib/api/notebooks";
import type { UserAvatarUser } from "@/lib/avatar-color";

// The REST shape of lab notebooks. People and tokens sit in separate fields,
// the way run comments report their author. The browser reads the same
// shape, so this module has no server imports.

export interface NotebookWireUser {
  avatarUrl: string | null;
  displayName: string;
  id: string;
  initials: string;
}

export interface NotebookWireToken {
  id: string;
  name: string;
}

export interface NotebookWire {
  created_at: string;
  created_by: NotebookWireUser | null;
  created_by_token: NotebookWireToken | null;
  deleted_at: string | null;
  deleted_by: NotebookWireUser | null;
  deleted_by_token: NotebookWireToken | null;
  description: string | null;
  id: string;
  instrument_count: number;
  last_run_at: string | null;
  name: string;
  owner: NotebookWireUser | null;
  run_count: number;
  updated_at: string;
  updated_by: NotebookWireUser | null;
  updated_by_token: NotebookWireToken | null;
  url: string;
  url_key: string;
}

/** A notebook as a run lists it. */
export interface RunNotebookWire {
  id: string;
  linked_at: string;
  linked_by: NotebookWireUser | null;
  linked_by_token: NotebookWireToken | null;
  name: string;
  url: string;
  url_key: string;
}

function avatarToWire(user: UserAvatarUser): NotebookWireUser {
  return {
    id: user.userId,
    displayName: user.displayName,
    initials: user.initials,
    avatarUrl: user.avatarUrl,
  };
}

function wireUser(actor: Actor | null): NotebookWireUser | null {
  return actor?.kind === "user" ? avatarToWire(actor.user) : null;
}

function wireToken(actor: Actor | null): NotebookWireToken | null {
  return actor?.kind === "token"
    ? { id: actor.token.id, name: actor.token.name }
    : null;
}

export function notebookToWire(notebook: NotebookDto): NotebookWire {
  return {
    id: notebook.id,
    url: notebook.url,
    url_key: notebook.urlKey,
    name: notebook.name,
    description: notebook.description,
    owner: notebook.owner ? avatarToWire(notebook.owner) : null,
    run_count: notebook.runCount,
    instrument_count: notebook.instrumentCount,
    last_run_at: notebook.lastRunAt?.toISOString() ?? null,
    created_at: notebook.createdAt.toISOString(),
    created_by: wireUser(notebook.createdBy),
    created_by_token: wireToken(notebook.createdBy),
    updated_at: notebook.updatedAt.toISOString(),
    updated_by: wireUser(notebook.updatedBy),
    updated_by_token: wireToken(notebook.updatedBy),
    deleted_at: notebook.deletedAt?.toISOString() ?? null,
    deleted_by: wireUser(notebook.deletedBy),
    deleted_by_token: wireToken(notebook.deletedBy),
  };
}

export function runNotebookToWire(notebook: RunNotebookDto): RunNotebookWire {
  return {
    id: notebook.id,
    name: notebook.name,
    url: notebook.url,
    url_key: notebook.urlKey,
    linked_at: notebook.linkedAt.toISOString(),
    linked_by: wireUser(notebook.linkedBy),
    linked_by_token: wireToken(notebook.linkedBy),
  };
}

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

export interface NotebookRunsWire<O extends string> {
  counts: Record<O, number>;
  notebook_id: string;
  results: Array<{ instrument_id: string; outcome: O; run_id: string }>;
}

export function runOutcomesToWire<O extends string>(
  outcomes: readonly O[],
  result: RunOutcomes<O>
): NotebookRunsWire<O> {
  return {
    notebook_id: result.notebookId,
    results: result.results.map((entry) => ({
      instrument_id: entry.instrumentId,
      run_id: entry.runId,
      outcome: entry.outcome,
    })),
    counts: countOutcomes(outcomes, result.results),
  };
}

export type AddRunsWire = NotebookRunsWire<AddRunOutcome>;
export type RemoveRunsWire = NotebookRunsWire<RemoveRunOutcome>;

function actorFromWire(
  user: NotebookWireUser | null,
  token: NotebookWireToken | null
): Actor | null {
  if (user) {
    return {
      kind: "user",
      user: {
        userId: user.id,
        displayName: user.displayName,
        initials: user.initials,
        avatarUrl: user.avatarUrl,
      },
    };
  }
  if (token) {
    // The wire has no revoked flag, so a token reads as active.
    return { kind: "token", token: { ...token, revoked: false } };
  }
  return null;
}

/** Who added a run to a notebook, as the UI's actor labels expect it. */
export function runNotebookLinker(notebook: RunNotebookWire): Actor | null {
  return actorFromWire(notebook.linked_by, notebook.linked_by_token);
}

/** Who deleted a notebook, as the UI's actor labels expect it. */
export function notebookDeleter(notebook: NotebookWire): Actor | null {
  return actorFromWire(notebook.deleted_by, notebook.deleted_by_token);
}
