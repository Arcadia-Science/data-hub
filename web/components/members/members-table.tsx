import { AdminToggle } from "@/components/members/admin-toggle";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { UserAvatarLink } from "@/components/user-avatar";
import { toInitials } from "@/lib/avatar-color";

export interface MemberRow {
  email: string | null;
  id: string;
  image: string | null;
  isAdmin: boolean;
  name: string | null;
}

interface MembersTableProps {
  /**
   * The signed-in admin viewing the table. Used to flag the self row so
   * the toggle is disabled (server also rejects self-demotion).
   */
  currentUserId: string;
  data: MemberRow[];
}

/**
 * Placeholder mirroring `MembersTable` columns (avatar + name, email, role
 * badge, admin switch) so streamed content swaps in without layout shift.
 */
export function MembersTableSkeleton({
  rows = 3,
  ariaLabel = "Loading members",
}: {
  rows?: number;
  ariaLabel?: string;
}) {
  return (
    <div
      aria-busy="true"
      aria-label={ariaLabel}
      className="overflow-hidden rounded-lg border bg-background dark:bg-muted"
      role="status"
    >
      <Table className="table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead className="w-[40%]">Member</TableHead>
            <TableHead className="w-[35%]">Email</TableHead>
            <TableHead>Role</TableHead>
            <TableHead className="w-28 text-right">Admin</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: rows }).map((_, i) => (
            <TableRow key={i}>
              <TableCell>
                <div className="flex min-w-0 items-center gap-3">
                  <Skeleton className="size-6 shrink-0 rounded-full" />
                  <Skeleton className="h-4 w-28 max-w-full" />
                </div>
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-36 max-w-full" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-5 w-16 rounded-full" />
              </TableCell>
              <TableCell className="overflow-hidden text-right">
                <div className="flex justify-end">
                  <Skeleton className="h-[18.4px] w-8 rounded-full" />
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function MembersTable({ data, currentUserId }: MembersTableProps) {
  return (
    // overflow-hidden clips sub-pixel / switch hit-target bleed that otherwise
    // leaves a ~5px horizontal scrollbar on the shared table container.
    <div className="overflow-hidden rounded-lg border bg-background dark:bg-muted">
      <Table className="table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead className="w-[40%]">Member</TableHead>
            <TableHead className="w-[35%]">Email</TableHead>
            <TableHead>Role</TableHead>
            <TableHead className="w-28 text-right">Admin</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((member) => {
            const displayName = member.name ?? member.email ?? "Unknown member";
            const isSelf = member.id === currentUserId;
            return (
              <TableRow key={member.id}>
                <TableCell className="max-w-0">
                  <UserAvatarLink
                    className="flex w-full min-w-0 gap-3"
                    size="sm"
                    user={{
                      userId: member.id,
                      displayName,
                      initials: toInitials(displayName),
                      avatarUrl: member.image,
                    }}
                  >
                    <span className="truncate font-medium">
                      {displayName}
                      {isSelf ? (
                        <span className="ml-1.5 text-muted-foreground text-xs">
                          (you)
                        </span>
                      ) : null}
                    </span>
                  </UserAvatarLink>
                </TableCell>
                <TableCell className="max-w-0 truncate text-muted-foreground">
                  {member.email ?? "—"}
                </TableCell>
                <TableCell>
                  {member.isAdmin ? (
                    <Badge className="bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300">
                      Admin
                    </Badge>
                  ) : (
                    <Badge variant="outline">Member</Badge>
                  )}
                </TableCell>
                <TableCell className="overflow-hidden text-right">
                  <div className="flex justify-end">
                    <AdminToggle
                      displayName={displayName}
                      isAdmin={member.isAdmin}
                      isSelf={isSelf}
                      userId={member.id}
                    />
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
