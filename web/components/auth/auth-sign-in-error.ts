import { redirect } from "next/navigation";
import { PLACEHOLDER_ORIGIN } from "@/lib/callback-url";

export type AuthSignInErrorCode = "google" | "credentials";

// Bounce back to the auth surface with a query param the banner can read.
// Parsing `errorPath` keeps the redirect on this site whatever it holds.
export function redirectWithAuthError(
  errorPath: string,
  code: AuthSignInErrorCode
): never {
  const url = new URL(errorPath, PLACEHOLDER_ORIGIN);
  url.searchParams.set("error", code);
  redirect(`${url.pathname}${url.search}`);
}
