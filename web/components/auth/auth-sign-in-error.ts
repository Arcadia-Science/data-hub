import { redirect } from "next/navigation";

export type AuthSignInErrorCode = "google" | "credentials";

// Bounce back to the auth surface with a query param the banner can read.
// Login uses `callbackUrl="/"` — send those errors to `/login` so the banner
// lands on the auth screen rather than the signed-out home page.
export function redirectWithAuthError(
  callbackUrl: string,
  code: AuthSignInErrorCode
): never {
  const path = callbackUrl === "/" ? "/login" : callbackUrl;
  const url = new URL(path, "http://local.invalid");
  url.searchParams.set("error", code);
  redirect(`${url.pathname}${url.search}`);
}
