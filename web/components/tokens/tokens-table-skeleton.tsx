import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * Placeholder mirroring the access-tokens table columns (name, avatar, token
 * badge, scope badges, timestamps, optional delete action) so streamed content
 * swaps in without layout shift.
 */
export function TokensTableSkeleton({
  withAdmin = false,
  rows = 5,
  ariaLabel = "Loading access tokens",
}: {
  withAdmin?: boolean;
  rows?: number;
  ariaLabel?: string;
}) {
  return (
    <div
      aria-busy="true"
      aria-label={ariaLabel}
      className="rounded-lg border bg-background dark:bg-muted"
      role="status"
    >
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
            {withAdmin ? <TableHead className="w-12" /> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: rows }).map((_, i) => (
            <TableRow key={i}>
              <TableCell>
                <Skeleton className="h-4 w-24" />
              </TableCell>
              <TableCell>
                <Skeleton className="size-6 rounded-full" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-5 w-16 rounded-full" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-5 w-20 rounded-full" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-16" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-16" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-16" />
              </TableCell>
              {withAdmin ? (
                <TableCell>
                  <Skeleton className="size-8 rounded-md" />
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
