import { AdminToggle } from "@/components/members/admin-toggle";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { UserAvatar } from "@/components/user-avatar";
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

export function MembersTable({ data, currentUserId }: MembersTableProps) {
  return (
    <div className="rounded-lg border bg-background dark:bg-muted">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Member</TableHead>
            <TableHead>Email</TableHead>
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
                <TableCell>
                  <div className="flex items-center gap-3">
                    <UserAvatar
                      size="sm"
                      user={{
                        userId: member.id,
                        displayName,
                        initials: toInitials(displayName),
                        avatarUrl: member.image,
                      }}
                    />
                    <div className="flex flex-col">
                      <span className="font-medium">
                        {displayName}
                        {isSelf ? (
                          <span className="ml-1.5 text-muted-foreground text-xs">
                            (you)
                          </span>
                        ) : null}
                      </span>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">
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
                <TableCell className="text-right">
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
