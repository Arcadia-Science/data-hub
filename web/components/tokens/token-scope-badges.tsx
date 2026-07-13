"use client";

import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { LEGACY_SCOPE_EXPANSIONS } from "@/lib/api/scopes";

// Client module so TooltipTrigger `asChild` hydrates correctly. Rendering
// that composition from an RSC intermittently drops the trigger children on
// soft navigation (radix-ui/primitives#3883); a full reload masked it.

// Compact scopes column. Four branches:
//
//   1. `[]` → "No scopes" pill. The DB column is non-null with a default of
//      `['*']` and the create-token form rejects empty arrays, so this
//      shouldn't appear in practice — but an explicit empty state is clearer
//      than a blank cell if it ever does (e.g. a manual SQL update).
//   2. `["*"]` (backfill wildcard) → single "Full access (legacy)" pill so
//      pre-scope tokens stand out and read as rotation candidates.
//   3. Single explicit scope → that scope as a badge, no tooltip needed
//      because everything is already visible.
//   4. Multiple explicit scopes → first scope (sorted) plus a "+N" counter
//      badge. Hovering the cell reveals the full list in a tooltip so the
//      table stays scannable on tokens with many scopes.
//
// Deprecated coarse `:write` scopes (superseded by fine-grained actions but
// still honored on old tokens) render with an amber tint wherever they
// appear, flagging them for re-issue.
const LEGACY_COARSE_SCOPES = new Set(Object.keys(LEGACY_SCOPE_EXPANSIONS));

function ScopeBadge({ scope }: { scope: string }) {
  const isLegacy = LEGACY_COARSE_SCOPES.has(scope);
  return (
    <Badge
      className={
        isLegacy
          ? "font-mono text-amber-600 text-xs dark:text-amber-500"
          : "font-mono text-xs"
      }
      variant="secondary"
    >
      {scope}
    </Badge>
  );
}

export function TokenScopeBadges({ scopes }: { scopes: string[] }) {
  if (scopes.length === 0) {
    return (
      <Badge
        className="text-muted-foreground text-xs italic"
        variant="secondary"
      >
        No scopes
      </Badge>
    );
  }

  if (scopes.length === 1 && scopes[0] === "*") {
    return (
      <Badge
        className="text-amber-600 text-xs dark:text-amber-500"
        variant="secondary"
      >
        Full access (legacy)
      </Badge>
    );
  }

  // Stable sort grouped by resource: scopes within the same resource share
  // a prefix, so a plain lexicographic sort already groups them. The first
  // entry in the sorted list is the one shown in the collapsed cell.
  const sorted = [...scopes].sort();

  if (sorted.length === 1) {
    return <ScopeBadge scope={sorted[0]} />;
  }

  const [first, ...rest] = sorted;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex w-fit flex-wrap items-center gap-1">
          <ScopeBadge scope={first} />
          <Badge className="text-xs" variant="secondary">
            +{rest.length}
          </Badge>
        </div>
      </TooltipTrigger>
      <TooltipContent>
        <div className="flex flex-col gap-0.5 font-mono text-xs">
          {sorted.map((scope) => (
            <span
              className={
                LEGACY_COARSE_SCOPES.has(scope)
                  ? "text-amber-600 dark:text-amber-500"
                  : undefined
              }
              key={scope}
            >
              {scope}
            </span>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
