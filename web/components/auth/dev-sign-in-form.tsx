"use client";

import { useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { SignIn, useClientSignIn, useSignIn } from "@/components/auth/sign-in";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signIn } from "@/lib/auth-client";
import { DEV_PASSWORD } from "@/lib/dev-auth";

// Dev-only email/password sign-in. Shared between `/login` (the dedicated
// sign-in route) and the in-page `SignInRequired` gate so both surfaces
// render the same affordance and never drift. Call sites must gate on
// `isDevAuthEnabled` — rendering this form is meaningless unless
// email/password is enabled in `lib/auth.ts`. The password is the shared
// seed constant; the form never asks for it.
//
// During MCP OAuth (`client_id` in the URL), sign in from the client so
// `oauthProviderClient` can attach signed `oauth_query` and Better Auth can
// resume authorize after sign-in. Otherwise submit the server action so
// Set-Cookie still flows through `nextCookies`.

interface DevSignInFormProps {
  inputId?: string;
  /**
   * Server action used for normal (non-MCP-OAuth) dev sign-in.
   * Receives the form's email field via FormData.
   */
  signInAction: (formData: FormData) => Promise<void>;
}

function DevChrome({ children }: { children: ReactNode }) {
  return (
    <div className="w-full border-border border-t pt-6">
      <p className="mb-3 text-center text-muted-foreground text-xs uppercase tracking-wider">
        Local development
      </p>
      {children}
    </div>
  );
}

function DevEmailField({ inputId }: { inputId: string }) {
  const {
    state: { pending },
  } = useSignIn();

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={inputId}>Email</Label>
      <Input
        defaultValue="alice@example.com"
        disabled={pending}
        id={inputId}
        name="email"
        placeholder="alice@example.com"
        required
        type="email"
      />
    </div>
  );
}

function DevSubmit() {
  return (
    <SignIn.Submit className="w-full cursor-pointer">
      Sign in (dev)
    </SignIn.Submit>
  );
}

function DevOAuthProvider({ children }: { children: ReactNode }) {
  const value = useClientSignIn(async (formData) => {
    const emailRaw = formData?.get("email");
    const email =
      typeof emailRaw === "string" ? emailRaw.trim().toLowerCase() : "";
    // Omit callbackURL so the OAuth resume path (oauth_query) wins.
    const result = await signIn.email({ email, password: DEV_PASSWORD });
    return result.error
      ? (result.error.message ?? "Couldn't sign in with that email.")
      : null;
  }, "Couldn't sign in with that email.");

  return <SignIn.Provider {...value}>{children}</SignIn.Provider>;
}

function DevOAuthSignIn({ inputId }: { inputId: string }) {
  return (
    <DevOAuthProvider>
      <DevChrome>
        <SignIn.ClientFrame className="flex w-full flex-col gap-3">
          <DevEmailField inputId={inputId} />
          <DevSubmit />
          <SignIn.Error />
        </SignIn.ClientFrame>
      </DevChrome>
    </DevOAuthProvider>
  );
}

function DevServerSignIn({
  inputId,
  signInAction,
}: {
  inputId: string;
  signInAction: (formData: FormData) => Promise<void>;
}) {
  return (
    <DevChrome>
      <SignIn.Frame
        action={signInAction}
        className="flex w-full flex-col gap-3"
      >
        <DevEmailField inputId={inputId} />
        <DevSubmit />
      </SignIn.Frame>
    </DevChrome>
  );
}

export function DevSignInForm({
  signInAction,
  inputId = "dev-sign-in-email",
}: DevSignInFormProps) {
  const searchParams = useSearchParams();
  const isOAuthAuthorize = Boolean(searchParams.get("client_id"));

  return isOAuthAuthorize ? (
    <DevOAuthSignIn inputId={inputId} />
  ) : (
    <DevServerSignIn inputId={inputId} signInAction={signInAction} />
  );
}
