import { createHash, randomBytes } from "node:crypto";

const TOKEN_PREFIX = "dhub_";

export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("hex");
}

export function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

export function getTokenPrefix(plaintext: string): string {
  // "dhub_" (5) + first 4 hex chars — enough to identify a token in the UI
  // without leaking meaningful entropy.
  return plaintext.slice(0, TOKEN_PREFIX.length + 4);
}
