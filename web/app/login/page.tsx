import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isDevAuthEnabled, signIn } from "@/lib/auth";
import { Metadata } from "next/types";

export const metadata: Metadata = {
  title: "Login",
};

export default function LoginPage() {
  return (
    <div className="flex h-screen w-full items-center justify-center">
      <div className="mx-auto flex w-full max-w-md flex-col items-center gap-6">
        <div className="flex flex-col items-center gap-4 text-center">
          <h1 className="text-3xl font-semibold tracking-tight">
            Welcome to Data Hub
          </h1>
          <p className="text-muted-foreground">
            Sign in with your Google Workspace account to continue.
          </p>
        </div>
        <form
          action={async () => {
            "use server";
            await signIn("google", { redirectTo: "/" });
          }}
          className="w-full"
        >
          <Button className="w-full cursor-pointer py-5 text-base" size="lg">
            Sign in with Google
          </Button>
        </form>
        {isDevAuthEnabled && <DevSignInForm />}
      </div>
    </div>
  );
}

// Dev-only password-less sign-in. Looks up the supplied email in the
// `user` table (typically a row seeded by `npm run db:seed`) and mints a
// session via the `dev` Credentials provider in `lib/auth.ts`. The whole
// component is rendered only when `isDevAuthEnabled` is true — which is
// derived from `process.env.NODE_ENV !== "production"` server-side — so
// production builds never ship the affordance.
function DevSignInForm() {
  return (
    <div className="w-full border-t border-border pt-6">
      <p className="mb-3 text-center text-xs tracking-wider text-muted-foreground uppercase">
        Local development
      </p>
      <form
        action={async (formData: FormData) => {
          "use server";
          const email = formData.get("email");
          await signIn("dev", {
            email: typeof email === "string" ? email : "",
            redirectTo: "/",
          });
        }}
        className="flex w-full flex-col gap-3"
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="dev-email">Email</Label>
          <Input
            id="dev-email"
            name="email"
            type="email"
            placeholder="dev@local"
            defaultValue="dev@local"
            required
          />
        </div>
        <Button
          type="submit"
          variant="outline"
          className="w-full cursor-pointer"
        >
          Sign in (dev)
        </Button>
      </form>
    </div>
  );
}
