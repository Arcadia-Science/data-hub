import Image from "next/image";
import type { Metadata } from "next/types";
import { DevSignInForm } from "@/components/auth/dev-sign-in-form";
import { Button } from "@/components/ui/button";
import { isDevAuthEnabled, signIn } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Login",
};

export default function LoginPage() {
  return (
    <div className="flex h-screen w-full items-center justify-center">
      <div className="mx-auto flex w-full max-w-md flex-col items-center gap-6">
        <div className="flex flex-col items-center gap-4 text-center">
          <Image
            alt="Data Hub"
            height={64}
            priority
            src="/images/data-hub-logo.svg"
            width={64}
          />
          <h1 className="mt-2 font-semibold text-3xl tracking-tight">
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
