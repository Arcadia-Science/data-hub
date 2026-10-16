import { redirect } from "next/navigation";
import { signInErrorPath } from "@/lib/callback-url";

export type AuthSignInErrorCode = "google" | "credentials";

// Bounce back to the auth surface with a query param the banner can read,
// keeping the return address so a retry still lands on the requested page.
export function redirectWithAuthError(
  callbackUrl: string,
  code: AuthSignInErrorCode,
  fromLoginPage: boolean
): never {
  const url = new URL(
    signInErrorPath(callbackUrl, fromLoginPage),
    "http://local.invalid"
  );
  url.searchParams.set("error", code);
  redirect(`${url.pathname}${url.search}`);
}
