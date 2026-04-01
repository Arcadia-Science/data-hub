import { Button } from "@/components/ui/button";
import { signOut } from "@/lib/auth";
import { LogOut } from "lucide-react";
import type { Session } from "next-auth";

export function DashboardHeader({ session }: { session: Session }) {
  return (
    <header className="flex items-center justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Data Hub</h1>
        <p className="text-sm text-muted-foreground">{session.user?.email}</p>
      </div>
      <form
        action={async () => {
          "use server";
          await signOut({ redirectTo: "/login" });
        }}
      >
        <Button variant="outline" size="sm" className="cursor-pointer gap-1.5">
          <LogOut className="size-3.5" />
          Sign out
        </Button>
      </form>
    </header>
  );
}
