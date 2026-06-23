import { asc } from "drizzle-orm";
import { ShieldOff } from "lucide-react";
import type { Metadata } from "next/types";
import { SignInRequired } from "@/components/auth/sign-in-required";
import { MembersTable } from "@/components/members/members-table";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

const description = "Manage workspace members and admin access.";

export const metadata: Metadata = {
  title: "Members",
  description,
  openGraph: { title: "Members", description },
  twitter: { title: "Members", description },
};

export default async function MembersPage() {
  const session = await auth();
  if (!session?.user) {
    return (
      <SignInRequired callbackUrl="/settings/members">
        Sign in to manage members.
      </SignInRequired>
    );
  }

  // Page-level admin gate. Non-admins reach this URL via a stale link,
  // bookmark, or by typing it in — render an explicit explanation rather
  // than redirecting silently so the missing-permission failure mode is
  // visible. The settings sidebar already hides this entry for non-admins.
  if (!session.user.isAdmin) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed bg-background py-16 dark:bg-muted">
        <ShieldOff className="size-10 text-muted-foreground/50" />
        <p className="mt-3 font-medium text-muted-foreground text-sm">
          Admins only
        </p>
        <p className="mt-1 max-w-sm text-center text-muted-foreground/70 text-sm">
          You need workspace admin access to view or change member roles. Ask an
          existing admin if you need to be promoted.
        </p>
      </div>
    );
  }

  const members = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      image: users.image,
      isAdmin: users.isAdmin,
    })
    .from(users)
    .orderBy(asc(users.email));

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-lg tracking-tight">Members</h2>
          <p className="text-muted-foreground text-sm">
            Grant or revoke admin access for teammates signed in to Data Hub.
          </p>
        </div>
      </div>

      <div className="mt-6">
        <MembersTable currentUserId={session.user.id} data={members} />
      </div>
    </div>
  );
}
