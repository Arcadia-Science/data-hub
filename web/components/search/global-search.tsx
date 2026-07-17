"use client";

import { Command as CommandPrimitive } from "cmdk";
import { Clock, SearchIcon, SearchX } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  SearchCommentRow,
  SearchFileRow,
  SearchInstrumentRow,
  SearchRunRow,
  SearchUserRow,
} from "@/components/search/search-result-item";
import { useRecentSearches } from "@/components/search/use-recent-searches";
import {
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  GlobalSearchResult,
  SearchCommentResult,
  SearchFileResult,
  SearchInstrumentResult,
  SearchRunResult,
  SearchScope,
  SearchUserResult,
} from "@/lib/api/search";
import { MIN_QUERY_LENGTH } from "@/lib/search-constants";
import { cn } from "@/lib/utils";

const DEBOUNCE_MS = 200;

const SCOPE_TABS: { id: SearchScope; label: string }[] = [
  { id: "all", label: "All" },
  { id: "runs", label: "Runs" },
  { id: "files", label: "Files" },
  { id: "instruments", label: "Instruments" },
  { id: "users", label: "Users" },
  { id: "comments", label: "Comments" },
];

const EMPTY_RESULT: GlobalSearchResult = {
  runs: [],
  files: [],
  instruments: [],
  users: [],
  comments: [],
  counts: {
    runs: 0,
    files: 0,
    instruments: 0,
    users: 0,
    comments: 0,
    total: 0,
  },
};

function runHref(run: SearchRunResult): string {
  return `/instruments/${run.instrumentId}/runs/${encodeURIComponent(run.runId)}`;
}

// Files have no standalone page, so deep-link to the parent run and pre-fill
// the run-detail files search (which already filters + highlights that table).
function fileHref(file: SearchFileResult): string {
  return `/instruments/${file.instrumentId}/runs/${encodeURIComponent(
    file.runId
  )}?files_search=${encodeURIComponent(file.filename)}`;
}

function instrumentHref(instrument: SearchInstrumentResult): string {
  return `/instruments/${instrument.id}`;
}

function userHref(user: SearchUserResult): string {
  return `/users/${user.id}`;
}

function commentHref(comment: SearchCommentResult): string {
  return `/instruments/${comment.instrumentId}/runs/${encodeURIComponent(
    comment.runId
  )}#comment-${comment.id}`;
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
      {children}
    </kbd>
  );
}

export function GlobalSearch({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const { recent, add: addRecent } = useRecentSearches();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<SearchScope>("all");
  const [result, setResult] = useState<GlobalSearchResult>(EMPTY_RESULT);
  const [loading, setLoading] = useState(false);

  const trimmed = query.trim();
  const isSearchable = trimmed.length >= MIN_QUERY_LENGTH;

  // Reset transient state whenever the modal closes so the next open starts
  // clean (empty query, "All" tab, recent-searches view).
  useEffect(() => {
    if (!open) {
      setQuery("");
      setScope("all");
      setResult(EMPTY_RESULT);
      setLoading(false);
    }
  }, [open]);

  // Debounced, race-safe fetch. An AbortController cancels the in-flight
  // request when the query/scope changes so stale responses can't overwrite
  // fresher ones.
  useEffect(() => {
    if (!(open && isSearchable)) {
      setResult(EMPTY_RESULT);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: trimmed, scope });
        const res = await fetch(`/api/v1/search?${params}`, {
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`Search failed: ${res.status}`);
        }
        const data = (await res.json()) as GlobalSearchResult;
        setResult(data);
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          setResult(EMPTY_RESULT);
        }
      } finally {
        // Only the latest (non-aborted) request clears the spinner.
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }, DEBOUNCE_MS);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [open, trimmed, isSearchable, scope]);

  const navigate = useCallback(
    (href: string) => {
      addRecent(trimmed);
      onOpenChange(false);

      // Same-pathname `#comment-{id}` links must not go through App Router
      // `push` alone — it uses pushState and does not fire `hashchange`, so
      // the comments list would never scroll when already on the run page.
      const url = new URL(href, window.location.origin);
      if (
        url.hash.startsWith("#comment-") &&
        url.pathname === window.location.pathname
      ) {
        if (url.hash === window.location.hash) {
          document
            .getElementById(url.hash.slice(1))
            ?.scrollIntoView({ block: "center" });
        } else {
          window.history.pushState(
            null,
            "",
            `${url.pathname}${url.search}${url.hash}`
          );
          window.dispatchEvent(new HashChangeEvent("hashchange"));
        }
        return;
      }

      router.push(href);
    },
    [addRecent, trimmed, onOpenChange, router]
  );

  const showRecent = !isSearchable;
  const hasResults = result.counts.total > 0;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="top-[12%] w-full translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-[600px]"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Search Data Hub</DialogTitle>
        <DialogDescription className="sr-only">
          Search across runs, files, instruments, users, and comments.
        </DialogDescription>

        <CommandPrimitive
          className="flex w-full min-w-0 max-w-full flex-col overflow-hidden"
          label="Search runs, files, instruments, users, or comments"
          loop
          shouldFilter={false}
        >
          <div className="flex items-center gap-2 border-b px-4">
            <SearchIcon className="size-5 shrink-0 text-muted-foreground" />
            {/* Radix Dialog moves focus to the first focusable element (this
                input) on open, so no explicit autoFocus is needed. */}
            <CommandPrimitive.Input
              className="flex h-12 w-full bg-transparent text-base outline-none placeholder:text-muted-foreground"
              onValueChange={setQuery}
              placeholder="Search runs, files, instruments, users, or comments"
              value={query}
            />
            <Kbd>esc</Kbd>
          </div>

          <div className="flex items-center gap-0.5 overflow-x-auto border-b px-2 py-2">
            {SCOPE_TABS.map((tab) => (
              <button
                className={cn(
                  "shrink-0 rounded-md px-2.5 py-1 font-medium text-sm transition-colors",
                  scope === tab.id
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
                key={tab.id}
                onClick={() => setScope(tab.id)}
                type="button"
              >
                {tab.label}
              </button>
            ))}
          </div>

          {isSearchable ? (
            <div
              aria-live="polite"
              className="px-4 pt-3 pb-1 text-muted-foreground text-xs"
            >
              {loading
                ? "Searching…"
                : `${result.counts.total} ${
                    result.counts.total === 1 ? "result" : "results"
                  } for "${trimmed}"`}
            </div>
          ) : null}

          <CommandList className="max-h-[420px] min-w-0 px-2 pb-2">
            {showRecent ? (
              <RecentSearches
                onSelect={(value) => setQuery(value)}
                recent={recent}
              />
            ) : null}

            {isSearchable && !loading && !hasResults ? (
              <NoResults query={trimmed} />
            ) : null}

            {isSearchable && hasResults ? (
              <>
                {result.runs.length > 0 ? (
                  <CommandGroup heading="Runs">
                    {result.runs.map((run) => (
                      <CommandItem
                        key={run.id}
                        onSelect={() => navigate(runHref(run))}
                        value={`run:${run.id}`}
                      >
                        <SearchRunRow query={trimmed} result={run} />
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ) : null}

                {result.files.length > 0 ? (
                  <CommandGroup heading="Files">
                    {result.files.map((file) => (
                      <CommandItem
                        key={file.id}
                        onSelect={() => navigate(fileHref(file))}
                        value={`file:${file.id}`}
                      >
                        <SearchFileRow query={trimmed} result={file} />
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ) : null}

                {result.instruments.length > 0 ? (
                  <CommandGroup heading="Instruments">
                    {result.instruments.map((instrument) => (
                      <CommandItem
                        key={instrument.id}
                        onSelect={() => navigate(instrumentHref(instrument))}
                        value={`instrument:${instrument.id}`}
                      >
                        <SearchInstrumentRow
                          query={trimmed}
                          result={instrument}
                        />
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ) : null}

                {result.users.length > 0 ? (
                  <CommandGroup heading="Users">
                    {result.users.map((user) => (
                      <CommandItem
                        key={user.id}
                        onSelect={() => navigate(userHref(user))}
                        value={`user:${user.id}`}
                      >
                        <SearchUserRow query={trimmed} result={user} />
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ) : null}

                {result.comments.length > 0 ? (
                  <CommandGroup heading="Comments">
                    {result.comments.map((comment) => (
                      <CommandItem
                        key={comment.id}
                        onSelect={() => navigate(commentHref(comment))}
                        value={`comment:${comment.id}`}
                      >
                        <SearchCommentRow query={trimmed} result={comment} />
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ) : null}
              </>
            ) : null}
          </CommandList>

          <div className="flex items-center justify-between border-t px-4 py-2.5 text-muted-foreground text-xs">
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1">
                <Kbd>↑↓</Kbd> navigate
              </span>
              <span className="flex items-center gap-1">
                <Kbd>↵</Kbd> open
              </span>
            </div>
            <span className="flex items-center gap-1">
              <Kbd>⌘K</Kbd> to open from anywhere
            </span>
          </div>
        </CommandPrimitive>
      </DialogContent>
    </Dialog>
  );
}

function RecentSearches({
  recent,
  onSelect,
}: {
  recent: string[];
  onSelect: (value: string) => void;
}) {
  if (recent.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
        <SearchIcon className="size-7 text-muted-foreground" />
        <p className="text-muted-foreground text-sm">
          Search runs, files, instruments, users, or comments
        </p>
      </div>
    );
  }

  return (
    <CommandGroup heading="Recent searches">
      {recent.map((value) => (
        <CommandItem
          key={value}
          onSelect={() => onSelect(value)}
          // Prefix keeps recent-search values from colliding with result ids.
          value={`recent:${value}`}
        >
          <Clock className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{value}</span>
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

function NoResults({ query }: { query: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <SearchX className="size-7 text-muted-foreground" />
      <p className="text-muted-foreground text-sm">No results for "{query}"</p>
    </div>
  );
}
