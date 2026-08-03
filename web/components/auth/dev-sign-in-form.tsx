"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
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

export function DevSignInForm({
  signInAction,
  inputId = "dev-sign-in-email",
}: DevSignInFormProps) {
  const searchParams = useSearchParams();
  const isOAuthAuthorize = Boolean(searchParams.get("client_id"));
  const [clientError, setClientError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (isOAuthAuthorize) {
    return (
      <div className="w-full border-border border-t pt-6">
        <p className="mb-3 text-center text-muted-foreground text-xs uppercase tracking-wider">
          Local development
        </p>
        <form
          className="flex w-full flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const formData = new FormData(event.currentTarget);
            const emailRaw = formData.get("email");
            const email =
              typeof emailRaw === "string" ? emailRaw.trim().toLowerCase() : "";
            setClientError(null);
            setPending(true);
            // Omit callbackURL so the OAuth resume path (oauth_query) wins.
            void signIn
              .email({ email, password: DEV_PASSWORD })
              .then((result) => {
                if (result.error) {
                  setClientError(
                    result.error.message ?? "Couldn't sign in with that email."
                  );
                  setPending(false);
                }
              })
              .catch((err: unknown) => {
                setClientError(
                  err instanceof Error
                    ? err.message
                    : "Couldn't sign in with that email."
                );
                setPending(false);
              });
          }}
        >
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
          <Button
            className="w-full cursor-pointer"
            disabled={pending}
            type="submit"
            variant="outline"
          >
            {pending ? "Signing in…" : "Sign in (dev)"}
          </Button>
          {clientError ? (
            <p className="text-destructive text-sm" role="alert">
              {clientError}
            </p>
          ) : null}
        </form>
      </div>
    );
  }

  return (
    <div className="w-full border-border border-t pt-6">
      <p className="mb-3 text-center text-muted-foreground text-xs uppercase tracking-wider">
        Local development
      </p>
      <form action={signInAction} className="flex w-full flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={inputId}>Email</Label>
          <Input
            defaultValue="alice@example.com"
            id={inputId}
            name="email"
            placeholder="alice@example.com"
            required
            type="email"
          />
        </div>
        <Button
          className="w-full cursor-pointer"
          type="submit"
          variant="outline"
        >
          Sign in (dev)
        </Button>
      </form>
    </div>
  );
}
