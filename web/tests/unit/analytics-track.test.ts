import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const track = vi.fn();
const scheduled: Array<() => Promise<void>> = [];
let afterThrows = false;

vi.mock("@vercel/analytics/server", () => ({
  track: (...args: unknown[]) => track(...args),
}));

vi.mock("next/server", () => ({
  after: (fn: () => Promise<void>) => {
    if (afterThrows) {
      throw new Error("no request scope");
    }
    scheduled.push(fn);
  },
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "user-agent": "test" }),
}));

import { trackEvent } from "@/lib/analytics/track";

describe("trackEvent", () => {
  const env = { ...process.env };

  beforeEach(() => {
    track.mockReset();
    scheduled.length = 0;
    afterThrows = false;
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = { ...env };
    vi.restoreAllMocks();
  });

  it("does nothing outside production", () => {
    vi.stubEnv("VERCEL_ENV", "");
    trackEvent("web_visit", { user_id: "user-1", is_admin: false });
    expect(track).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(0);
    expect(console.debug).not.toHaveBeenCalled();
  });

  it("prints the event in development", () => {
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("NODE_ENV", "development");
    trackEvent("token_created", { user_id: "user-1" });
    expect(console.debug).toHaveBeenCalledWith("[analytics]", "token_created", {
      user_id: "user-1",
    });
    expect(scheduled).toHaveLength(0);
  });

  it("sends after the response in production", async () => {
    process.env.VERCEL_ENV = "production";
    trackEvent("sign_in", { user_id: "user-1", method: "google" });
    expect(track).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);
    await scheduled[0]?.();
    expect(track).toHaveBeenCalledWith(
      "sign_in",
      { user_id: "user-1", method: "google" },
      { headers: expect.any(Headers) }
    );
  });

  it("swallows a failed send", async () => {
    process.env.VERCEL_ENV = "production";
    track.mockRejectedValueOnce(new Error("intake down"));
    trackEvent("web_visit", { user_id: "user-1", is_admin: true });
    await expect(scheduled[0]?.()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(
      "[analytics] failed to send event",
      "web_visit",
      expect.any(Error)
    );
  });

  it("swallows a failure to schedule", () => {
    process.env.VERCEL_ENV = "production";
    afterThrows = true;
    expect(() =>
      trackEvent("web_visit", { user_id: "user-1", is_admin: false })
    ).not.toThrow();
    expect(console.error).toHaveBeenCalledWith(
      "[analytics] failed to schedule event",
      "web_visit",
      expect.any(Error)
    );
  });
});
