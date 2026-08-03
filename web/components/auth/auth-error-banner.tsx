"use client";

import { useSearchParams } from "next/navigation";

const MESSAGES: Record<string, string> = {
  google: "Couldn't start Google sign-in. Try again?",
  credentials: "Couldn't sign in with that email.",
  account_not_linked:
    "We couldn't link your Google account to an existing Data Hub user. Please try again.",
  unable_to_link_account:
    "We couldn't link your Google account. Please try again.",
  email_not_found:
    "Google did not return an email address for this account. Please try another account.",
  access_denied: "Sign-in was cancelled. Please try again when you're ready.",
  please_restart_the_process: "Sign-in expired. Please try again.",
  state_mismatch: "Sign-in expired. Please try again.",
  unable_to_get_user_info:
    "We couldn't read your Google profile. Please try again.",
};

const GENERIC_SIGN_IN_FAILED = "Sign-in failed. Please try again.";

function messageForAuthError(code: string | null): string | null {
  if (!code) {
    return null;
  }
  // Only render known codes. Unknown `?error=` values are attacker-
  // controlled query text — never echo them into the page.
  return MESSAGES[code] ?? GENERIC_SIGN_IN_FAILED;
}

// Reads `?error=` set by Better Auth (`onAPIError.errorURL`) or the sign-in
// server actions when an attempt is rejected.
export function AuthErrorBanner() {
  const params = useSearchParams();
  const message = messageForAuthError(params.get("error"));
  if (!message) {
    return null;
  }
  return (
    <p className="mt-4 text-destructive text-sm" role="alert">
      {message}
    </p>
  );
}
