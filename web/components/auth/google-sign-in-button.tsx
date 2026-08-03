"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { signIn } from "@/lib/auth-client";

function GoogleIcon() {
  return (
    <svg
      aria-hidden
      className="size-5"
      viewBox="0 0 48 48"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>Google</title>
      <path
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
        fill="#EA4335"
      />
      <path
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
        fill="#4285F4"
      />
      <path
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
        fill="#FBBC05"
      />
      <path
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
        fill="#34A853"
      />
    </svg>
  );
}

interface GoogleSignInButtonProps {
  /**
   * Server action used for normal (non-MCP-OAuth) Google sign-in so Set-Cookie
   * still flows through `nextCookies` + Next's `cookies()` helper.
   */
  signInAction: () => Promise<void>;
}

/**
 * During MCP OAuth (`client_id` in the URL), sign in from the client so
 * `oauthProviderClient` can attach signed `oauth_query` and Better Auth can
 * resume authorize after Google. Otherwise submit the server action.
 */
export function GoogleSignInButton({ signInAction }: GoogleSignInButtonProps) {
  const searchParams = useSearchParams();
  const isOAuthAuthorize = Boolean(searchParams.get("client_id"));
  const [clientError, setClientError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (isOAuthAuthorize) {
    return (
      <div className="w-full">
        <Button
          className="h-11 w-full cursor-pointer gap-3 bg-background text-base shadow-xs"
          disabled={pending}
          onClick={() => {
            setClientError(null);
            setPending(true);
            // `oauthProviderClient` reads authorize params from the URL and
            // forwards them; omit callbackURL so the OAuth resume path wins.
            void signIn
              .social({ provider: "google" })
              .then((result) => {
                if (result.error) {
                  setClientError(
                    result.error.message ?? "Couldn't start Google sign-in."
                  );
                  setPending(false);
                }
              })
              .catch((err: unknown) => {
                setClientError(
                  err instanceof Error
                    ? err.message
                    : "Couldn't start Google sign-in."
                );
                setPending(false);
              });
          }}
          size="lg"
          type="button"
          variant="outline"
        >
          <GoogleIcon />
          {pending ? "Redirecting…" : "Sign in with Google"}
        </Button>
        {clientError ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {clientError}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <form action={signInAction} className="w-full">
      <Button
        className="h-11 w-full cursor-pointer gap-3 bg-background text-base shadow-xs"
        size="lg"
        type="submit"
        variant="outline"
      >
        <GoogleIcon />
        Sign in with Google
      </Button>
    </form>
  );
}
