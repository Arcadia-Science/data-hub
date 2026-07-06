import { TokensTableSkeleton } from "@/components/tokens/tokens-table-skeleton";
import { auth } from "@/lib/auth";

export default async function TokensSettingsLoading() {
  const session = await auth();
  const isAdmin = session?.user?.isAdmin === true;

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
      </div>
      <div className="mt-6">
        <TokensTableSkeleton withAdmin={isAdmin} />
      </div>
    </div>
  );
}
