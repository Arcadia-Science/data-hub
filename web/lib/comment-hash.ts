// Deep-link format shared by notifications, global search, and Slack DMs.
// `#comment-{id}` (not a bare UUID) so the fragment can't collide with other
// page anchors.

export const COMMENT_HASH_PREFIX = "#comment-";

export function commentAnchorId(commentId: string): string {
  return `comment-${commentId}`;
}

export function commentHash(commentId: string): string {
  return `${COMMENT_HASH_PREFIX}${commentId}`;
}

export function isCommentHash(hash: string): boolean {
  return hash.startsWith(COMMENT_HASH_PREFIX);
}

export function runCommentHref(
  instrumentId: string,
  runId: string,
  commentId?: string | null
): string {
  const path = `/instruments/${encodeURIComponent(instrumentId)}/runs/${encodeURIComponent(runId)}`;
  return commentId ? `${path}${commentHash(commentId)}` : path;
}
