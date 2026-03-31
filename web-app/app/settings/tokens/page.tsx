import { CreateTokenDialog } from "@/components/tokens/create-token-dialog";
import { DeleteTokenDialog } from "@/components/tokens/delete-token-dialog";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { personalAccessTokens } from "@/lib/db/schema";
import { formatRelativeTime } from "@/lib/utils";
import { desc, eq } from "drizzle-orm";
import { KeyRound } from "lucide-react";
import { redirect } from "next/navigation";

export default async function TokensPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login");
  }

  const tokens = await db
    .select({
      id: personalAccessTokens.id,
      name: personalAccessTokens.name,
      tokenPrefix: personalAccessTokens.tokenPrefix,
      lastUsedAt: personalAccessTokens.lastUsedAt,
      expiresAt: personalAccessTokens.expiresAt,
      createdAt: personalAccessTokens.createdAt,
    })
    .from(personalAccessTokens)
    .where(eq(personalAccessTokens.userId, session.user.id))
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
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12">
            <KeyRound className="size-10 text-muted-foreground/50" />
            <p className="mt-3 text-sm font-medium text-muted-foreground">
              No access tokens yet
            </p>
            <p className="mt-1 text-sm text-muted-foreground/70">
              Create a token to authenticate with the API.
            </p>
          </div>
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Token</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {tokens.map((token) => (
                  <TableRow key={token.id}>
                    <TableCell className="font-medium">{token.name}</TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="font-mono text-xs">
                        {token.tokenPrefix}...
                      </Badge>
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
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}
