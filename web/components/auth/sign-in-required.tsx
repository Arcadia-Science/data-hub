import { Button } from "@/components/ui/button";
import { signIn } from "@/lib/auth";

type SignInRequiredProps = {
  /**
   * URL the user should land on after a successful sign-in. The unfurler
   * arrives here without a session, so `callbackUrl` lets us return them to
   * the exact page they originally clicked on once they sign in.
   */
  callbackUrl: string;
  /**
   * The page-specific blurb (e.g. "Sign in to view this run."). We take it
   * as `children` rather than a string prop so call sites can drop in
   * inline formatting without us inventing per-case prop variants.
   */
  children?: React.ReactNode;
};

/**
 * Rendered in place of a signed-in page's body when there's no session.
 *
 * The page's `metadata` / `generateMetadata` is unaffected, so unfurlers
 * (Slackbot, NotionBot, Discordbot, etc.) still see the real `<title>` /
 * `og:title` / `og:description` for the route. Real users land on a clean
 * sign-in CTA that returns them to the original URL afterwards.
 *
 * Mirrors the visual shell of `app/login/page.tsx` so the experience is
 * indistinguishable from hitting `/login` directly.
 */
export function SignInRequired({ callbackUrl, children }: SignInRequiredProps) {
  return (
    <div className="flex h-[calc(100svh-3rem)] w-full items-center justify-center">
      <div className="mx-auto flex w-full max-w-md flex-col items-center gap-6">
        <div className="flex flex-col items-center gap-4 text-center">
          <h1 className="text-3xl font-semibold tracking-tight">
            Sign in to Data Hub
          </h1>
          {children ? (
            <p className="text-muted-foreground">{children}</p>
          ) : null}
        </div>
        <form
          action={async () => {
            "use server";
            await signIn("google", { redirectTo: callbackUrl });
          }}
          className="w-full"
        >
          <Button className="w-full cursor-pointer py-5 text-base" size="lg">
            Sign in with Google
          </Button>
        </form>
      </div>
    </div>
  );
}
