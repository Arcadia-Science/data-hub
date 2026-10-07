import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  isFreshWebhookTimestamp,
  verifyLinearWebhookSignature,
} from "@/lib/linear/webhook";

const SECRET = "webhook-secret";
const BODY = '{"type":"Issue"}';

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

describe("Linear webhook verification", () => {
  it("accepts a signature of the raw body", () => {
    expect(verifyLinearWebhookSignature(BODY, sign(BODY), SECRET)).toBe(true);
  });

  it("rejects a tampered body, a wrong secret, and a missing header", () => {
    expect(verifyLinearWebhookSignature(`${BODY} `, sign(BODY), SECRET)).toBe(
      false
    );
    expect(
      verifyLinearWebhookSignature(BODY, sign(BODY, "other"), SECRET)
    ).toBe(false);
    expect(verifyLinearWebhookSignature(BODY, null, SECRET)).toBe(false);
    expect(verifyLinearWebhookSignature(BODY, "zz", SECRET)).toBe(false);
  });

  it("accepts a timestamp within a minute and rejects an older one", () => {
    const now = 1_700_000_000_000;
    expect(isFreshWebhookTimestamp(now - 30_000, now)).toBe(true);
    expect(isFreshWebhookTimestamp(now - 61_000, now)).toBe(false);
    expect(isFreshWebhookTimestamp(Number.NaN, now)).toBe(false);
  });
});
