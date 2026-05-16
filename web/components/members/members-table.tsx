import { AdminToggle } from "@/components/members/admin-toggle";
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
import { avatarColor, toInitials } from "@/lib/avatar-color";

export type MemberRow = {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
  isAdmin: boolean;
};

type MembersTableProps = {
  data: MemberRow[];
  /**
   * The signed-in admin viewing the table. Used to flag the self row so
   * the toggle is disabled (server also rejects self-demotion).
   */
  currentUserId: string;
};

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
                    <Avatar size="sm">
                      {member.image ? (
                        <AvatarImage src={member.image} alt={displayName} />
                      ) : null}
                      <AvatarFallback className={avatarColor(member.id)}>
                        {toInitials(displayName)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex flex-col">
                      <span className="font-medium">
                        {displayName}
                        {isSelf ? (
                          <span className="ml-1.5 text-xs text-muted-foreground">
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
                    <Badge variant="secondary">Admin</Badge>
                  ) : (
                    <Badge variant="outline" className="text-muted-foreground">
                      Member
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end">
                    <AdminToggle
                      userId={member.id}
                      isAdmin={member.isAdmin}
                      isSelf={isSelf}
                      displayName={displayName}
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
