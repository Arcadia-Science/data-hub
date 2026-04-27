import { UserMenu } from "@/components/dashboard/user-menu";
import { NavLinks } from "@/components/nav-links";
import { signOut } from "@/lib/auth";
import type { Session } from "next-auth";
import Image from "next/image";
import Link from "next/link";

export function Navbar({ session }: { session: Session }) {
  return (
    <header>
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
        <div className="flex items-center gap-5">
          <Link
            href="/"
            className="flex items-center gap-1 text-lg leading-none font-medium"
          >
            <Image
              src="/arcadia-logo-xs.svg"
              alt="Arcadia"
              width={26}
              height={26}
              priority
              className="h-7 w-auto dark:invert"
            />
            Data Hub
          </Link>
          <NavLinks />
        </div>
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
