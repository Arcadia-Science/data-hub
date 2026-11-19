"use client";

import { Command as CommandPrimitive } from "cmdk";
import { Loader2, SearchIcon } from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { CommandItem, CommandList } from "@/components/ui/command";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useUnsavedChangesWarning } from "@/hooks/use-unsaved-changes-warning";
import type { NotebookWire } from "@/lib/api/notebook-wire";
import {
  notebookNameFromUrl,
  notebookNameSchema,
} from "@/lib/notebook-links/url";
import {
  type NotebookLookup,
  type NotebookPickerState,
  type NotebookQuery,
  notebookPickerState,
  readNotebookQuery,
  runsAlreadyIn,
} from "@/lib/runs/notebook-picker";
import {
  type NotebookPick,
  searchNotebooks,
} from "@/lib/runs/notebook-requests";
import { cn } from "@/lib/utils";

// Wait this long after the last keystroke before searching by name. A pasted
// link is looked up at once.
const SEARCH_DEBOUNCE_MS = 200;
const RESULTS_PER_SEARCH = 8;

export interface NotebookPickerValues {
  claim: boolean;
}

function lookupKey(query: NotebookQuery, attempt: number): string {
  return `${query.kind}\u0000${query.kind === "link" ? query.url : query.text}\u0000${attempt}`;
}

/**
 * Finds notebooks by name as the person types, or looks up the notebook for
 * a pasted link. Results from an earlier query stay until the new ones
 * arrive, so the list doesn't flash empty between keystrokes.
 */
function useNotebookLookup(query: NotebookQuery, attempt: number) {
  const key = lookupKey(query, attempt);
  const isLink = query.kind === "link";
  const text = query.kind === "link" ? query.url : query.text;
  const [result, setResult] = useState<{
    key: string;
    notebooks: NotebookWire[] | null;
  } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(
      async () => {
        let notebooks: NotebookWire[] | null = null;
        try {
          notebooks = await searchNotebooks(text, {
            // A link finds its page's notebook even when it's deleted, so the
            // picker can offer to restore it.
            includeDeleted: isLink,
            perPage: RESULTS_PER_SEARCH,
            signal: controller.signal,
          });
        } catch {
          notebooks = null;
        }
        if (!controller.signal.aborted) {
          setResult({ key, notebooks });
        }
      },
      isLink ? 0 : SEARCH_DEBOUNCE_MS
    );
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [key, isLink, text]);

  const current = result?.key === key ? result : null;
  let lookup: NotebookLookup<NotebookWire>;
  if (!current) {
    lookup = { status: "loading" };
  } else if (current.notebooks) {
    lookup = { status: "done", notebooks: current.notebooks };
  } else {
    lookup = { status: "failed" };
  }
  return { lookup, shown: result?.notebooks ?? [] };
}

function statusText(
  query: NotebookQuery,
  state: NotebookPickerState<NotebookWire>,
  lookup: NotebookLookup<NotebookWire>,
  shownCount: number
): string {
  if (query.kind === "link") {
    switch (state.kind) {
      case "looking_up":
        return "Looking up this page…";
      case "lookup_failed":
        return "Couldn't look up this page.";
      case "create":
        return "No notebook has this page yet.";
      default:
        return "";
    }
  }
  if (lookup.status === "failed") {
    return "Couldn't load notebooks.";
  }
  if (lookup.status === "loading") {
    return shownCount === 0 ? "Searching…" : "";
  }
  if (lookup.notebooks.length > 0) {
    return "";
  }
  return query.text
    ? "No notebooks match. Paste a link to a page to create one."
    : "No notebooks yet. Paste a link to a page to create one.";
}

/**
 * Picks the lab notebook to add runs to. One box finds a notebook by name or
 * takes a pasted link: a link to a page that has a notebook picks it, a
 * link to a new page asks for a name to create one, and a link to a deleted
 * notebook's page offers to restore it, and a new notebook suggests the
 * viewer as its owner. `onSave` adds the runs and returns
 * an error to show, or null once they're in. `claimLabel` adds an "I ran
 * this" checkbox, off by default.
 */
export function NotebookPickerForm({
  runNotebookIds,
  claimLabel,
  onSave,
  onCancel,
}: {
  // One entry per run being added: the notebooks it's already in.
  runNotebookIds: ReadonlyArray<readonly string[]>;
  claimLabel?: string;
  onSave: (
    pick: NotebookPick,
    values: NotebookPickerValues
  ) => Promise<string | null>;
  onCancel: () => void;
}) {
  const id = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const [input, setInput] = useState("");
  const [picked, setPicked] = useState<NotebookWire | null>(null);
  // The list row the arrow keys are on, by notebook ID.
  const [highlighted, setHighlighted] = useState("");
  // A typed name for a new page. Until the person types one, the name is
  // worked out from the link.
  const [nameDraft, setNameDraft] = useState<{
    url: string;
    value: string;
  } | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [claim, setClaim] = useState(false);
  // A new notebook suggests the viewer as its owner.
  const [ownedByMe, setOwnedByMe] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Bumped to look the link up again after a save fails, in case someone
  // else created or restored its notebook meanwhile.
  const [attempt, setAttempt] = useState(0);

  const query = readNotebookQuery(input);
  const { lookup, shown } = useNotebookLookup(query, attempt);
  const state = notebookPickerState({ query, lookup, picked });
  const runCount = runNotebookIds.length;
  const theseRuns = runCount === 1 ? "this run" : "these runs";

  const createUrl = state.kind === "create" ? state.url : null;
  const name =
    createUrl === null
      ? ""
      : nameDraft?.url === createUrl
        ? nameDraft.value
        : notebookNameFromUrl(createUrl);

  const chosen =
    state.kind === "existing" || state.kind === "restore"
      ? state.notebook
      : null;
  const alreadyIn = chosen ? runsAlreadyIn(runNotebookIds, chosen.id) : 0;

  useUnsavedChangesWarning(input.trim() !== "" || claim);

  // A link lists only its own notebook; a name search keeps the last results
  // on screen while the next ones load.
  let rows: NotebookWire[] = [];
  if (query.kind === "name") {
    rows = shown;
  } else if (chosen) {
    rows = [chosen];
  }
  const status = statusText(query, state, lookup, rows.length);
  const loading =
    lookup.status === "loading" && (query.kind === "link" || rows.length > 0);

  function changeInput(value: string) {
    setInput(value);
    setPicked(null);
    setError(null);
    setNameError(null);
  }

  function pick(notebook: NotebookWire) {
    setError(null);
    // A link already picked the only notebook it lists. A name search keeps
    // its text, so the list stays put with a check on the pick.
    if (query.kind === "name") {
      setPicked(notebook);
    }
  }

  function resolvePick(): NotebookPick | null {
    switch (state.kind) {
      case "searching":
        setError(
          input.trim()
            ? "Pick a notebook from the list, or paste a link to its page."
            : "Find a notebook by name, or paste a link to its page."
        );
        searchRef.current?.focus();
        return null;
      case "looking_up":
        return null;
      case "lookup_failed":
        setError("Couldn't look up this page. Try again?");
        setAttempt((n) => n + 1);
        return null;
      case "existing": {
        if (alreadyIn === runCount) {
          setError(
            runCount === 1
              ? "This run is already in this notebook."
              : "These runs are already in this notebook."
          );
          return null;
        }
        const { id: notebookId, name: notebookName, url } = state.notebook;
        return {
          kind: "existing",
          notebook: { id: notebookId, name: notebookName, url },
        };
      }
      case "restore": {
        const { id: notebookId, name: notebookName, url } = state.notebook;
        return {
          kind: "restore",
          notebook: { id: notebookId, name: notebookName, url },
        };
      }
      case "create": {
        const parsed = notebookNameSchema.safeParse(name);
        if (!parsed.success) {
          setNameError(parsed.error.issues[0]?.message ?? "Enter a name.");
          nameRef.current?.focus();
          return null;
        }
        return {
          kind: "create",
          url: state.url,
          name: parsed.data,
          ownedByMe,
        };
      }
      default:
        return null;
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (submitting) {
      return;
    }
    setError(null);
    setNameError(null);
    const next = resolvePick();
    if (!next) {
      return;
    }
    setSubmitting(true);
    const saveError = await onSave(next, { claim });
    setSubmitting(false);
    if (saveError) {
      setError(saveError);
      if (next.kind !== "existing") {
        setAttempt((n) => n + 1);
      }
    }
  }

  // What sending the form will do with the picked notebook.
  let note = "";
  if (state.kind === "existing") {
    const notebookName = state.notebook.name;
    if (alreadyIn === runCount) {
      note = `${runCount === 1 ? "This run is" : "These runs are"} already in “${notebookName}”.`;
    } else if (alreadyIn > 0) {
      note = `Adds these runs to “${notebookName}”. ${alreadyIn} of the ${runCount} are already in it and are skipped.`;
    } else {
      note = `Adds ${theseRuns} to “${notebookName}”.`;
    }
  } else if (state.kind === "restore") {
    note = `“${state.notebook.name}” is deleted. Restoring it brings back the runs it had and adds ${theseRuns}.`;
  }

  let submitLabel = "Add to notebook";
  if (state.kind === "create") {
    submitLabel = "Create and add";
  } else if (state.kind === "restore") {
    submitLabel = "Restore and add";
  }

  const statusId = `${id}-status`;
  const errorId = `${id}-error`;
  const noteId = `${id}-note`;

  return (
    <form
      className="flex flex-col gap-3"
      noValidate
      onKeyDown={(event) => {
        if (event.key === "Escape" && !submitting) {
          event.stopPropagation();
          onCancel();
        }
      }}
      onSubmit={handleSubmit}
      ref={formRef}
    >
      <FieldGroup className="gap-3">
        <Field data-invalid={error !== null}>
          {/* The box's accessible name comes from the command menu's own
              label, which has the same text. */}
          <FieldTitle aria-hidden="true">Notebook</FieldTitle>
          <CommandPrimitive
            className={cn(
              "flex flex-col overflow-hidden rounded-md border border-input bg-background shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30",
              error !== null &&
                "border-destructive ring-3 ring-destructive/20 dark:border-destructive/50 dark:ring-destructive/40"
            )}
            label="Notebook"
            loop
            onValueChange={setHighlighted}
            shouldFilter={false}
            value={highlighted}
          >
            <div className="flex items-center gap-2 px-2.5">
              <SearchIcon
                aria-hidden="true"
                className="size-4 shrink-0 text-muted-foreground"
              />
              <CommandPrimitive.Input
                aria-describedby={[
                  statusId,
                  error === null ? null : errorId,
                  noteId,
                ]
                  .filter(Boolean)
                  .join(" ")}
                aria-invalid={error !== null}
                // Opening the form is a request to pick a notebook.
                autoFocus
                className="h-9 w-full min-w-0 bg-transparent text-base outline-none placeholder:text-muted-foreground md:text-sm"
                inputMode="search"
                onKeyDown={(event) => {
                  if (event.key !== "Enter") {
                    return;
                  }
                  // Enter on a new page's link moves on to its name. Enter on
                  // the notebook that's already picked sends the form, and on
                  // any other row picks that row instead.
                  if (state.kind === "create") {
                    event.preventDefault();
                    nameRef.current?.focus();
                  } else if (
                    chosen &&
                    (query.kind === "link" || highlighted === chosen.id)
                  ) {
                    event.preventDefault();
                    formRef.current?.requestSubmit();
                  }
                }}
                onValueChange={changeInput}
                placeholder="Find by name or paste a link…"
                ref={searchRef}
                value={input}
              />
              {loading ? (
                <Loader2
                  aria-hidden="true"
                  className="size-4 shrink-0 animate-spin text-muted-foreground"
                />
              ) : null}
            </div>
            <CommandList
              className={cn(
                "max-h-56 border-t p-1",
                rows.length === 0 && "hidden"
              )}
            >
              {rows.map((notebook) => {
                const inIt = runsAlreadyIn(runNotebookIds, notebook.id);
                return (
                  <CommandItem
                    data-checked={chosen?.id === notebook.id}
                    key={notebook.id}
                    onSelect={() => pick(notebook)}
                    value={notebook.id}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {notebook.name}
                    </span>
                    {notebook.deleted_at === null ? null : (
                      <Badge variant="secondary">Deleted</Badge>
                    )}
                    <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                      {inIt === runCount
                        ? `Has ${theseRuns}`
                        : `${notebook.run_count} ${notebook.run_count === 1 ? "run" : "runs"}`}
                    </span>
                  </CommandItem>
                );
              })}
            </CommandList>
            <p
              aria-live="polite"
              // Kept in the page while empty, so screen readers announce
              // the next message.
              className={
                status === ""
                  ? "sr-only"
                  : "border-t px-2.5 py-2 text-muted-foreground text-sm"
              }
              id={statusId}
            >
              {status}
            </p>
          </CommandPrimitive>
          {error ? <FieldError id={errorId}>{error}</FieldError> : null}
          <FieldDescription
            aria-live="polite"
            className={note === "" ? "sr-only" : undefined}
            id={noteId}
          >
            {note}
          </FieldDescription>
        </Field>
        {createUrl === null ? null : (
          <Field data-invalid={nameError !== null}>
            <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
            <Input
              aria-describedby={`${id}-name-hint`}
              aria-invalid={nameError !== null}
              autoComplete="off"
              id={`${id}-name`}
              onChange={(event) => {
                setNameError(null);
                setNameDraft({ url: createUrl, value: event.target.value });
              }}
              ref={nameRef}
              value={name}
            />
            <FieldDescription id={`${id}-name-hint`}>
              The page is new to Data Hub, so it becomes a new notebook with
              this name.
            </FieldDescription>
            {nameError ? <FieldError>{nameError}</FieldError> : null}
          </Field>
        )}
        {createUrl === null ? null : (
          <Field orientation="horizontal">
            <Checkbox
              checked={ownedByMe}
              id={`${id}-owner`}
              onCheckedChange={(checked) => setOwnedByMe(checked === true)}
            />
            <FieldLabel className="font-normal" htmlFor={`${id}-owner`}>
              Make me the owner
            </FieldLabel>
          </Field>
        )}
        {claimLabel ? (
          <Field orientation="horizontal">
            <Checkbox
              checked={claim}
              id={`${id}-claim`}
              onCheckedChange={(checked) => setClaim(checked === true)}
            />
            <FieldLabel className="font-normal" htmlFor={`${id}-claim`}>
              {claimLabel}
            </FieldLabel>
          </Field>
        ) : null}
      </FieldGroup>
      <div className="flex justify-end gap-2">
        <Button
          disabled={submitting}
          onClick={onCancel}
          size="sm"
          type="button"
          variant="ghost"
        >
          Cancel
        </Button>
        <Button disabled={submitting} size="sm" type="submit">
          {submitting ? (
            <Loader2 className="animate-spin" data-icon="inline-start" />
          ) : null}
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
