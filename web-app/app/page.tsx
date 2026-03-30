import { Button } from "@/components/ui/button";
import { auth, signOut } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Metadata } from "next/types";

export const metadata: Metadata = {
  title: "Home | Data Hub",
};

export default async function Page() {
  const session = await auth();

  if (!session) {
    redirect("/login");
  }

  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <div className="flex max-w-md flex-col gap-4 text-center">
        <h1 className="text-2xl font-semibold">Welcome to Data Hub</h1>
        <p className="text-muted-foreground">
          Signed in as {session.user?.email}
        </p>
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/login" });
          }}
        >
          <Button variant="outline" className="cursor-pointer" size="lg">
            Sign out
          </Button>
        </form>
      </div>
    </div>
  );
}
