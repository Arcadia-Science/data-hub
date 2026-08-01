"use client";

import { useSearchParams } from "next/navigation";

const MESSAGES: Record<string, string> = {
  google: "Couldn't start Google sign-in. Try again?",
  credentials: "Couldn't sign in with that email.",
};

// Reads `?error=` set by the sign-in server actions when Better Auth
// rejects the attempt (missing Google config, unknown seeded email, …).
export function AuthErrorBanner() {
  const params = useSearchParams();
  const code = params.get("error");
  if (!code) {
    return null;
  }
  const message = MESSAGES[code];
  if (!message) {
    return null;
  }
  return (
    <p className="mt-4 text-destructive text-sm" role="alert">
      {message}
    </p>
  );
}
