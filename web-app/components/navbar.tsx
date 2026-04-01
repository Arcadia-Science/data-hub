import { UserMenu } from "@/components/dashboard/user-menu";
import { signOut } from "@/lib/auth";
import type { Session } from "next-auth";
import Link from "next/link";

export function Navbar({ session }: { session: Session }) {
  return (
    <header className="border-b bg-background">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-3">
        <Link href="/" className="text-lg font-medium tracking-tight">
          Data Hub
        </Link>
        <UserMenu
          user={session.user}
          signOutAction={async () => {
            "use server";
            await signOut({ redirectTo: "/login" });
          }}
        />
      </div>
    </header>
  );
}
