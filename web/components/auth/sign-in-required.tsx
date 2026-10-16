import { AuthScreen } from "@/components/auth/auth-screen";
import { getRequestPath } from "@/lib/request-path";

interface SignInRequiredProps {
  /**
   * Fallback for the URL the user lands on after signing in. Normally the
   * address (path and query) comes from the request header set by `proxy.ts`;
   * this is used only when the proxy didn't run for the render.
   */
  callbackUrl: string;
  /**
   * The page-specific blurb (e.g. "Sign in to view this run."). We take it
   * as `children` rather than a string prop so call sites can drop in
   * inline formatting without us inventing per-case prop variants.
   */
  children?: React.ReactNode;
}

/**
 * Rendered in place of a signed-in page's body when there's no session.
 *
 * The page's `metadata` / `generateMetadata` is unaffected, so unfurlers
 * (Slackbot, NotionBot, Discordbot, etc.) still see the real `<title>` /
 * `og:title` / `og:description` for the route. Real users land on a clean
 * sign-in CTA that returns them to the original URL afterwards.
 *
 * Mirrors the visual shell of `app/login/page.tsx` (including the
 * non-production dev sign-in affordance) so the experience is
 * indistinguishable from hitting `/login` directly. Both gates pull from
 * the same `isDevAuthEnabled` flag in `lib/dev-auth.ts`.
 */
export async function SignInRequired({
  callbackUrl,
  children,
}: SignInRequiredProps) {
  return (
    <AuthScreen
      callbackUrl={await getRequestPath(callbackUrl)}
      devInputId="sign-in-required-dev-email"
      heading="Sign in to Data Hub"
    >
      {children ?? "Sign in with your Google Workspace account to continue."}
    </AuthScreen>
  );
}
