// Plain-text ⌘K snippets for comment search hits. Kept client-safe (no DB)
// so unit tests and the server search builder can share the same helper.

// Short enough for a single command-palette row; the full body is matched in SQL.
export const COMMENT_PREVIEW_MAX = 120;

/**
 * Light markdown → plain text for one-line snippets. Not a full CommonMark
 * pass — just strip markers that commonly pollute a preview.
 */
export function markdownToPlainText(body: string): string {
  return (
    body
      // Fenced blocks rarely help a snippet; drop them entirely.
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/(\*\*|__)(.+?)\1/g, "$2")
      .replace(/(\*|_)(.+?)\1/g, "$2")
      .replace(/~~(.+?)~~/g, "$1")
      .replace(/^>\s+/gm, "")
      .replace(/^[-*+]\s+/gm, "")
      .replace(/^\d+\.\s+/gm, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Build a plain-text preview that keeps the first case-insensitive match for
 * `query` in view. Falls back to a head slice when the query isn't present in
 * the stripped text (e.g. the hit was only in markdown syntax we removed).
 */
export function commentBodyPreview(body: string, query: string): string {
  const plain = markdownToPlainText(body);
  if (plain.length <= COMMENT_PREVIEW_MAX) {
    return plain;
  }

  const needle = query.trim().toLowerCase();
  const matchIndex =
    needle.length > 0 ? plain.toLowerCase().indexOf(needle) : -1;

  if (matchIndex < 0) {
    return `${plain.slice(0, COMMENT_PREVIEW_MAX).trimEnd()}…`;
  }

  // Bias a little lead-in before the match so the highlight isn't flush left.
  const contextBefore = Math.floor((COMMENT_PREVIEW_MAX - needle.length) / 3);
  let start = Math.max(0, matchIndex - contextBefore);
  let end = start + COMMENT_PREVIEW_MAX;
  if (end > plain.length) {
    end = plain.length;
    start = Math.max(0, end - COMMENT_PREVIEW_MAX);
  }

  const prefix = start > 0 ? "…" : "";
  const suffix = end < plain.length ? "…" : "";
  return `${prefix}${plain.slice(start, end).trim()}${suffix}`;
}
