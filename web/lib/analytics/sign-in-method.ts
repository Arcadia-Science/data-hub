/**
 * Better Auth creates the Google session on `/callback/:id`, not on
 * `/sign-in/social` (that path only returns the redirect). The ID-token
 * flow still posts to `/sign-in/social`. Email/password is dev-only.
 */
export function signInMethod(
  path: string
): "google" | "credential" | "session" {
  if (path.includes("/callback/") || path.includes("/sign-in/social")) {
    return "google";
  }
  if (path.includes("/sign-in/email")) {
    return "credential";
  }
  return "session";
}
