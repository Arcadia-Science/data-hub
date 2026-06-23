// HMAC-based state token for the Slack OAuth flow.
//
// The signed state encodes the user's Data Hub user ID, a random nonce, and
// an expiry. Using `AUTH_SECRET` (or dedicated `SLACK_STATE_SECRET`) as the
// signing key avoids an extra env var while keeping the state tamper-proof.
// The state is HMAC-signed rather than encrypted, so anyone who intercepts it
// can read the user ID — but state is short-lived (15 min) and carries no
// credentials, so disclosure is not a security concern.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const STATE_TTL_MS = 15 * 60 * 1000; // 15 minutes

function getSecret(): string {
  const secret = process.env.SLACK_STATE_SECRET ?? process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "SLACK_STATE_SECRET (or AUTH_SECRET) must be set for Slack OAuth"
    );
  }
  return secret;
}

function hmac(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("hex");
}

/**
 * Generate a signed state string encoding `userId`.
 * Format: `<nonce>.<expiry>.<userId>.<signature>`
 */
export function generateState(userId: string): string {
  const nonce = randomBytes(16).toString("hex");
  const expiry = Date.now() + STATE_TTL_MS;
  const payload = `${nonce}.${expiry}.${userId}`;
  const sig = hmac(getSecret(), payload);
  return Buffer.from(`${payload}.${sig}`).toString("base64url");
}

/**
 * Verify and decode a state string. Returns `{ userId }` on success or
 * throws with a descriptive message on failure.
 */
export function verifyState(state: string): { userId: string } {
  let decoded: string;
  try {
    decoded = Buffer.from(state, "base64url").toString("utf8");
  } catch {
    throw new Error("Invalid state encoding");
  }

  const parts = decoded.split(".");
  if (parts.length !== 4) {
    throw new Error("Malformed state");
  }

  const [nonce, expiryStr, userId, sig] = parts;
  const payload = `${nonce}.${expiryStr}.${userId}`;
  const expectedSig = hmac(getSecret(), payload);

  // Constant-time compare to prevent timing attacks.
  const sigBuf = Buffer.from(sig, "hex");
  const expectedBuf = Buffer.from(expectedSig, "hex");
  if (
    sigBuf.length !== expectedBuf.length ||
    !timingSafeEqual(sigBuf, expectedBuf)
  ) {
    throw new Error("Invalid state signature");
  }

  const expiry = Number(expiryStr);
  if (Number.isNaN(expiry) || Date.now() > expiry) {
    throw new Error("State has expired");
  }

  return { userId };
}
