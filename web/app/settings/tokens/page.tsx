import { desc, eq } from "drizzle-orm";
import { KeyRound } from "lucide-react";
import type { Metadata } from "next/types";
import { Suspense } from "react";
import { SignInRequired } from "@/components/auth/sign-in-required";
import { CreateTokenDialog } from "@/components/tokens/create-token-dialog";
import { CreateTokenDisabledButton } from "@/components/tokens/create-token-disabled-button";
import { DeleteTokenDialog } from "@/components/tokens/delete-token-dialog";
import { TokensTableSkeleton } from "@/components/tokens/tokens-table-skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/user-avatar";
import { LEGACY_SCOPE_EXPANSIONS } from "@/lib/api/scopes";
import { auth } from "@/lib/auth";
import { toInitials } from "@/lib/avatar-color";
import { db } from "@/lib/db";
import { personalAccessTokens, users } from "@/lib/db/schema";
import { formatRelativeTime } from "@/lib/utils";

const description = "Personal access tokens for the Data Hub API.";

export const metadata: Metadata = {
  title: "Access Tokens",
  description,
  openGraph: { title: "Access Tokens", description },
  twitter: { title: "Access Tokens", description },
};

// Render a token's scopes as a compact column. Four branches:
//
//   1. `[]` → "No scopes" pill. The DB column is non-null with a default
//      of `['*']` and the create-token form rejects empty arrays, so this
//      shouldn't appear in practice — but rendering an explicit empty
//      state here is much clearer than a silently-empty cell if it ever
//      does happen (e.g. a manual SQL update).
//   2. `["*"]` (backfill wildcard) → single "Full access (legacy)" pill so
//      pre-scope tokens stand out and read as rotation candidates.
//   3. Single explicit scope → that scope as a badge, no tooltip needed
//      because everything is already visible.
//   4. Multiple explicit scopes → first scope (sorted) plus a "+N"
//      counter badge. Hovering the cell reveals the full list in a
//      tooltip so the table stays scannable on tokens with many scopes.
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

function TokenScopeBadges({ scopes }: { scopes: string[] }) {
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

export default async function TokensPage() {
  // Page-level auth gate so we never run the workspace-wide PAT query for
  // an unauthenticated visitor. The settings layout (`../layout.tsx`) also
  // renders `SignInRequired` when there's no session, but layouts can't
  // short-circuit page rendering — without this check the `db.select` below
  // would still execute (its result is then discarded by the layout, but
  // it's wasted DB work and a 500 from this query would slip past the
  // layout guard). NextAuth dedupes `auth()` per request, so the duplicate
  // call is free.
  const session = await auth();
  if (!session?.user) {
    return (
      <SignInRequired callbackUrl="/settings/tokens">
        Sign in to manage access tokens.
      </SignInRequired>
    );
  }

  // Mount the create dialog only for admins. Non-admins get a disabled button
  // with a tooltip so the form never enters the tree (and can't be re-enabled
  // via DevTools).
  const isAdmin = session.user.isAdmin === true;

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-lg tracking-tight">
            Access Tokens
          </h2>
          <p className="text-muted-foreground text-sm">
            {isAdmin
              ? "Manage personal access tokens for API authentication."
              : "View personal access tokens for API authentication."}
          </p>
        </div>
        {isAdmin ? (
          <CreateTokenDialog currentUserId={session.user.id} />
        ) : (
          <CreateTokenDisabledButton />
        )}
      </div>

      <div className="mt-6">
        <Suspense fallback={<TokensTableSkeleton withAdmin={isAdmin} />}>
          <TokensSection isAdmin={isAdmin} />
        </Suspense>
      </div>
    </div>
  );
}

async function TokensSection({ isAdmin }: { isAdmin: boolean }) {
  // This is an internal-tool settings page; we intentionally show every PAT
  // across the workspace so admins can audit them.
  const tokens = await db
    .select({
      id: personalAccessTokens.id,
      name: personalAccessTokens.name,
      tokenPrefix: personalAccessTokens.tokenPrefix,
      scopes: personalAccessTokens.scopes,
      lastUsedAt: personalAccessTokens.lastUsedAt,
      expiresAt: personalAccessTokens.expiresAt,
      createdAt: personalAccessTokens.createdAt,
      user: {
        id: users.id,
        name: users.name,
        email: users.email,
        image: users.image,
      },
    })
    .from(personalAccessTokens)
    .innerJoin(users, eq(users.id, personalAccessTokens.userId))
    .orderBy(desc(personalAccessTokens.createdAt));

  const isExpired = (expiresAt: Date | null) =>
    expiresAt ? expiresAt < new Date() : false;

  return (
    <>
      {tokens.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed bg-background py-12 dark:bg-muted">
          <KeyRound className="size-10 text-muted-foreground/50" />
          <p className="mt-3 font-medium text-muted-foreground text-sm">
            No access tokens yet
          </p>
          <p className="mt-1 text-muted-foreground/70 text-sm">
            {isAdmin
              ? "Create a token to authenticate with the API."
              : "Ask an admin to create a token for you."}
          </p>
        </div>
      ) : (
        <div className="rounded-lg border bg-background dark:bg-muted">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Token</TableHead>
                <TableHead>Scopes</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Created</TableHead>
                {isAdmin ? <TableHead className="w-12" /> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {tokens.map((token) => {
                const displayName =
                  token.user.name ?? token.user.email ?? "Unknown";
                return (
                  <TableRow key={token.id}>
                    <TableCell className="font-medium">{token.name}</TableCell>
                    <TableCell>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <UserAvatar
                            size="sm"
                            user={{
                              userId: token.user.id,
                              displayName,
                              initials: toInitials(displayName),
                              avatarUrl: token.user.image,
                            }}
                          />
                        </TooltipTrigger>
                        <TooltipContent>{displayName}</TooltipContent>
                      </Tooltip>
                    </TableCell>
                    <TableCell>
                      <Badge className="font-mono text-xs" variant="secondary">
                        {token.tokenPrefix}…
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <TokenScopeBadges scopes={token.scopes} />
                    </TableCell>
                    <TableCell
                      className="text-muted-foreground"
                      suppressHydrationWarning
                    >
                      {token.lastUsedAt
                        ? formatRelativeTime(token.lastUsedAt)
                        : "Never"}
                    </TableCell>
                    <TableCell suppressHydrationWarning>
                      {token.expiresAt ? (
                        <span
                          className={
                            isExpired(token.expiresAt)
                              ? "text-destructive"
                              : "text-muted-foreground"
                          }
                        >
                          {isExpired(token.expiresAt)
                            ? "Expired"
                            : formatRelativeTime(token.expiresAt)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">Never</span>
                      )}
                    </TableCell>
                    <TableCell
                      className="text-muted-foreground"
                      suppressHydrationWarning
                    >
                      {formatRelativeTime(token.createdAt)}
                    </TableCell>
                    {isAdmin ? (
                      <TableCell>
                        <DeleteTokenDialog
                          tokenId={token.id}
                          tokenName={token.name}
                        />
                      </TableCell>
                    ) : null}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
