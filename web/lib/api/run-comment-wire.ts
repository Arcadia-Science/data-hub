import type { RunCommentDto } from "@/lib/api/run-comments";

// REST and MCP responses keep the original `user` field for people and add
// `token` beside it, so existing callers keep working. Inside the app the
// author is a single `Actor`. This module has no server imports, so client
// components can use it to read their own API responses.
export interface RunCommentWire {
  body: string;
  created_at: string;
  edited_at: string | null;
  id: string;
  token: { id: string; name: string } | null;
  user: {
    id: string;
    displayName: string;
    initials: string;
    avatarUrl: string | null;
  } | null;
}

export function commentToWire(comment: RunCommentDto): RunCommentWire {
  const { author } = comment;
  return {
    id: comment.id,
    body: comment.body,
    user:
      author.kind === "user"
        ? {
            id: author.user.userId,
            displayName: author.user.displayName,
            initials: author.user.initials,
            avatarUrl: author.user.avatarUrl,
          }
        : null,
    token:
      author.kind === "token"
        ? { id: author.token.id, name: author.token.name }
        : null,
    created_at: comment.created_at.toISOString(),
    edited_at: comment.edited_at ? comment.edited_at.toISOString() : null,
  };
}

// The wire has no revoked flag, so a token author reads as active. Only
// people edit comments from the browser, so this path carries user authors.
export function commentFromWire(wire: RunCommentWire): RunCommentDto {
  const author: RunCommentDto["author"] = wire.user
    ? {
        kind: "user",
        user: {
          userId: wire.user.id,
          displayName: wire.user.displayName,
          initials: wire.user.initials,
          avatarUrl: wire.user.avatarUrl,
        },
      }
    : {
        kind: "token",
        token: {
          id: wire.token?.id ?? "unknown",
          name: wire.token?.name ?? "Unknown token",
          revoked: false,
        },
      };
  return {
    id: wire.id,
    body: wire.body,
    author,
    created_at: new Date(wire.created_at),
    edited_at: wire.edited_at ? new Date(wire.edited_at) : null,
  };
}
