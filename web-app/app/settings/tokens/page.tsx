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

export const metadata: Metadata = {
  title: "Access Tokens",
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

// Render a token's scopes as a compact column. `["*"]` is the backfill
// wildcard — render it as a single "Full access" pill so legacy tokens
// stand out at a glance, since they will eventually be rotated to
// least-privilege scopes. Anything else is rendered one badge per scope,
// grouped by resource so reads and writes for the same noun sit next to
// each other.
function TokenScopeBadges({ scopes }: { scopes: string[] }) {
  if (scopes.length === 1 && scopes[0] === "*") {
    return (
      <Badge variant="secondary" className="text-xs">
        Full access
      </Badge>
    );
  }
  // Stable sort grouped by resource: scopes within the same resource share
  // a prefix, so a plain lexicographic sort already groups them.
  const sorted = [...scopes].sort();
  return (
    <div className="flex flex-wrap gap-1">
      {sorted.map((scope) => (
        <Badge key={scope} variant="secondary" className="font-mono text-xs">
          {scope}
        </Badge>
      ))}
    </div>
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
                          {token.tokenPrefix}...
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
