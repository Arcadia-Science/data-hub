import { CreateTokenDialog } from "@/components/tokens/create-token-dialog";
import { DeleteTokenDialog } from "@/components/tokens/delete-token-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
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
import { db } from "@/lib/db";
import { personalAccessTokens, users } from "@/lib/db/schema";
import { formatRelativeTime } from "@/lib/utils";
import { desc, eq } from "drizzle-orm";
import { KeyRound } from "lucide-react";
import type { Metadata } from "next/types";

const description = "Personal access tokens for the Data Hub API.";

export const metadata: Metadata = {
  title: "Access Tokens",
  description,
  openGraph: { title: "Access Tokens", description },
  twitter: { title: "Access Tokens", description },
};

// Mirrors the deterministic palette used by RanByCell so the same user gets
// the same avatar bubble color across the run tables and this page.
const AVATAR_PALETTE = [
  "bg-blue-200 text-blue-900 dark:bg-blue-800 dark:text-blue-100",
  "bg-emerald-200 text-emerald-900 dark:bg-emerald-800 dark:text-emerald-100",
  "bg-violet-200 text-violet-900 dark:bg-violet-800 dark:text-violet-100",
  "bg-amber-200 text-amber-900 dark:bg-amber-800 dark:text-amber-100",
  "bg-rose-200 text-rose-900 dark:bg-rose-800 dark:text-rose-100",
  "bg-teal-200 text-teal-900 dark:bg-teal-800 dark:text-teal-100",
  "bg-fuchsia-200 text-fuchsia-900 dark:bg-fuchsia-800 dark:text-fuchsia-100",
  "bg-orange-200 text-orange-900 dark:bg-orange-800 dark:text-orange-100",
];

function avatarColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  }
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
}

function toInitials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Render a token's scopes as a compact column. Four branches:
//
//   1. `[]` → "No scopes" pill. The DB column is non-null with a default
//      of `['*']` and the create-token form rejects empty arrays, so this
//      shouldn't appear in practice — but rendering an explicit empty
//      state here is much clearer than a silently-empty cell if it ever
//      does happen (e.g. a manual SQL update).
//   2. `["*"]` (backfill wildcard) → single "Full access" pill so legacy
//      tokens stand out at a glance.
//   3. Single explicit scope → that scope as a badge, no tooltip needed
//      because everything is already visible.
//   4. Multiple explicit scopes → first scope (sorted) plus a "+N"
//      counter badge. Hovering the cell reveals the full list in a
//      tooltip so the table stays scannable on tokens with many scopes.
function TokenScopeBadges({ scopes }: { scopes: string[] }) {
  if (scopes.length === 0) {
    return (
      <Badge
        variant="secondary"
        className="text-xs text-muted-foreground italic"
      >
        No scopes
      </Badge>
    );
  }

  if (scopes.length === 1 && scopes[0] === "*") {
    return (
      <Badge variant="secondary" className="text-xs">
        Full access
      </Badge>
    );
  }

  // Stable sort grouped by resource: scopes within the same resource share
  // a prefix, so a plain lexicographic sort already groups them. The first
  // entry in the sorted list is the one shown in the collapsed cell.
  const sorted = [...scopes].sort();

  if (sorted.length === 1) {
    return (
      <Badge variant="secondary" className="font-mono text-xs">
        {sorted[0]}
      </Badge>
    );
  }

  const [first, ...rest] = sorted;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex w-fit flex-wrap items-center gap-1">
          <Badge variant="secondary" className="font-mono text-xs">
            {first}
          </Badge>
          <Badge variant="secondary" className="text-xs">
            +{rest.length}
          </Badge>
        </div>
      </TooltipTrigger>
      <TooltipContent>
        <div className="flex flex-col gap-0.5 font-mono text-xs">
          {sorted.map((scope) => (
            <span key={scope}>{scope}</span>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

export default async function TokensPage() {
  // This is an internal-tool settings page; we intentionally show every PAT
  // across the workspace so admins can audit them. Auth is enforced by the
  // settings layout.
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
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">
            Access Tokens
          </h2>
          <p className="text-sm text-muted-foreground">
            Manage personal access tokens for API authentication.
          </p>
        </div>
        <CreateTokenDialog />
      </div>

      <div className="mt-6">
        {tokens.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed bg-background py-12 dark:bg-muted">
            <KeyRound className="size-10 text-muted-foreground/50" />
            <p className="mt-3 text-sm font-medium text-muted-foreground">
              No access tokens yet
            </p>
            <p className="mt-1 text-sm text-muted-foreground/70">
              Create a token to authenticate with the API.
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
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {tokens.map((token) => {
                  const displayName =
                    token.user.name ?? token.user.email ?? "Unknown";
                  return (
                    <TableRow key={token.id}>
                      <TableCell className="font-medium">
                        {token.name}
                      </TableCell>
                      <TableCell>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Avatar size="sm">
                              {token.user.image ? (
                                <AvatarImage
                                  src={token.user.image}
                                  alt={displayName}
                                />
                              ) : null}
                              <AvatarFallback
                                className={avatarColor(token.user.id)}
                              >
                                {toInitials(displayName)}
                              </AvatarFallback>
                            </Avatar>
                          </TooltipTrigger>
                          <TooltipContent>{displayName}</TooltipContent>
                        </Tooltip>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="secondary"
                          className="font-mono text-xs"
                        >
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
                      <TableCell>
                        <DeleteTokenDialog
                          tokenId={token.id}
                          tokenName={token.name}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}
