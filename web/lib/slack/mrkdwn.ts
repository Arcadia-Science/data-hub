// Text typed by users (comments, names, run IDs, feedback, dispatched
// messages) is placed inside Slack mrkdwn. Slack treats `<...|...>` as a link
// or mention, so it must be escaped first. Slack names `&`, `<` and `>` as the
// only characters that need escaping.
export function escapeMrkdwn(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
