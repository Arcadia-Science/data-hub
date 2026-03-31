import { auth } from "@/lib/auth";
import { KeyRound } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <div className="mt-6 flex gap-8">
        <nav className="hidden w-48 shrink-0 sm:block">
          <ul className="space-y-1">
            <li>
              <Link
                href="/settings/tokens"
                className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <KeyRound className="size-4" />
                Access Tokens
              </Link>
            </li>
          </ul>
        </nav>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
