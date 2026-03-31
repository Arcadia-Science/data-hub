import { createHash, randomBytes } from "node:crypto";

const TOKEN_PREFIX = "dhub_";

export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("hex");
}

export function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

export function getTokenPrefix(plaintext: string): string {
  return plaintext.slice(0, 9);
}
