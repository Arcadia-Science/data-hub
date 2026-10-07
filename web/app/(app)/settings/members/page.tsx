import { asc } from "drizzle-orm";
import type { Metadata } from "next/types";
import { Suspense } from "react";
import { SignInRequired } from "@/components/auth/sign-in-required";
import {
  MembersTable,
  MembersTableSkeleton,
} from "@/components/members/members-table";
import { AdminsOnly } from "@/components/settings/admins-only";
import { SettingsPageContent } from "@/components/settings/settings-page-content";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

const description = "Manage who can use Data Hub and who has admin access.";

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
    return <AdminsOnly>view or change member roles</AdminsOnly>;
  }

  return (
    <SettingsPageContent className="w-3/4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-lg tracking-tight">Members</h2>
          <p className="text-muted-foreground text-sm">
            Grant or revoke admin access for teammates signed in to Data Hub.
          </p>
        </div>
      </div>

      <div className="mt-6">
        <Suspense fallback={<MembersTableSkeleton />}>
          <MembersSection currentUserId={session.user.id} />
        </Suspense>
      </div>
    </SettingsPageContent>
  );
}

async function MembersSection({ currentUserId }: { currentUserId: string }) {
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

  return <MembersTable currentUserId={currentUserId} data={members} />;
}
