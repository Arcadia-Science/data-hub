import { DevSignInForm } from "@/components/auth/dev-sign-in-form";
import { Button } from "@/components/ui/button";
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
        {isDevAuthEnabled && (
          <DevSignInForm callbackUrl="/" inputId="login-dev-email" />
        )}
      </div>
    </div>
  );
}
