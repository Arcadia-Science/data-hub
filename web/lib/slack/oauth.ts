export function getSlackRedirectUri(origin: string): string {
  return (
    process.env.SLACK_REDIRECT_URI ?? `${origin}/api/v1/settings/slack/callback`
  );
}
