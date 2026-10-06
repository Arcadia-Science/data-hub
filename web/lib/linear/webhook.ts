// Linear signs every webhook with HMAC-SHA256 of the raw body. The
// timestamp inside the body stops a captured request from being replayed.

import { createHmac, timingSafeEqual } from "node:crypto";

export const LINEAR_WEBHOOK_MAX_AGE_MS = 60_000;

export function verifyLinearWebhookSignature(
  rawBody: string,
  header: string | null,
  secret: string
): boolean {
  if (!(header && /^[0-9a-fA-F]+$/.test(header)) || header.length % 2 !== 0) {
    return false;
  }
  const received = Buffer.from(header, "hex");
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  if (received.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(received, expected);
}

export function isFreshWebhookTimestamp(
  timestampMs: number,
  now = Date.now()
): boolean {
  return (
    Number.isFinite(timestampMs) &&
    Math.abs(now - timestampMs) <= LINEAR_WEBHOOK_MAX_AGE_MS
  );
}
