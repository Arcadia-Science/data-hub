// Linear signs every webhook with HMAC-SHA256 of the raw body. The
// timestamp inside the body stops a captured request from being replayed.

import { createHmac, timingSafeEqual } from "node:crypto";

export const LINEAR_WEBHOOK_MAX_AGE_MS = 60_000;

export type LinearWebhookRejectionReason = "signature" | "stale";

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

// Published at https://linear.app/.well-known/appspecific/app.linear.ips.json.
// A valid signature is accepted from any address; this list only decides
// whether a rejection counts as Linear's.
export const LINEAR_WEBHOOK_IPS = new Set([
  "34.134.222.122",
  "34.140.253.14",
  "34.185.239.137",
  "34.186.126.124",
  "34.38.87.206",
  "34.48.40.158",
  "34.60.255.158",
  "34.62.119.29",
  "35.196.141.51",
  "35.222.25.142",
  "35.231.147.226",
  "35.236.218.67",
  "35.243.134.228",
  "35.246.206.27",
  "35.246.210.220",
]);

export function linearWebhookClientIp(request: Request): string | null {
  const real = request.headers.get("x-real-ip")?.trim();
  const forwarded = request.headers.get("x-forwarded-for");
  const raw = real || forwarded?.split(",")[0]?.trim() || "";
  if (!raw) {
    return null;
  }
  return raw.startsWith("::ffff:") ? raw.slice("::ffff:".length) : raw;
}

export function linearWebhookRejectionReason(input: {
  fresh: boolean;
  ip: string | null;
  organizationId: string | null;
  savedWorkspaceId: string | null;
  signatureOk: boolean;
}): LinearWebhookRejectionReason | null {
  if (input.signatureOk && input.fresh) {
    return null;
  }
  if (
    !(
      input.ip &&
      LINEAR_WEBHOOK_IPS.has(input.ip) &&
      input.savedWorkspaceId &&
      input.organizationId === input.savedWorkspaceId
    )
  ) {
    return null;
  }
  return input.signatureOk ? "stale" : "signature";
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
