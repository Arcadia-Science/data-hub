import { describe, expect, it } from "vitest";
import {
  blockSentence,
  blockWhen,
  describeBlock,
} from "@/lib/watchers/block-text";
import type { HealthBlock } from "@/lib/watchers/health";

const TZ = "UTC";
const WHEN = blockWhen("Tue, Nov 10", 19);

describe("blockWhen", () => {
  it("names the day and the 30 minutes", () => {
    expect(WHEN).toBe("Tue, Nov 10, 9:30 AM to 10:00 AM");
    expect(blockWhen("Tue, Nov 10", 47)).toBe(
      "Tue, Nov 10, 11:30 PM to 12:00 AM"
    );
  });
});

describe("describeBlock", () => {
  const block = (patch: Partial<HealthBlock>): HealthBlock => ({
    state: "checked_in",
    heartbeats: 30,
    ...patch,
  });

  it("checked in counts the heartbeats", () => {
    expect(describeBlock(block({}), WHEN, TZ)).toEqual({
      title: "Checked in",
      when: WHEN,
      detail: "30 heartbeats in these 30 minutes.",
    });
    expect(describeBlock(block({ heartbeats: 1 }), WHEN, TZ).detail).toBe(
      "1 heartbeat in these 30 minutes."
    );
  });

  it("words a block by its real length on a day the clocks go back", () => {
    expect(
      describeBlock(block({ heartbeats: 90, minutes: 90 }), WHEN, TZ).detail
    ).toBe("90 heartbeats in these 90 minutes.");
    expect(
      describeBlock(
        block({ state: "unresponsive", heartbeats: 0, minutes: 90 }),
        WHEN,
        TZ
      ).detail
    ).toBe("The watcher didn't check in during these 90 minutes.");
    expect(
      describeBlock(
        block({ state: "unresponsive", heartbeats: 4, minutes: 90 }),
        WHEN,
        TZ
      ).detail
    ).toBe("The watcher went quiet for part of these 90 minutes.");
  });

  it("a restart for an update says when it stopped and started again", () => {
    const text = describeBlock(
      block({
        state: "restarted",
        restart: {
          reason: "update",
          stoppedAt: new Date("2026-11-10T09:58:00Z"),
          resumedAt: new Date("2026-11-10T10:02:00Z"),
        },
      }),
      WHEN,
      TZ
    );
    expect(text.title).toBe("Restarted for an update");
    expect(text.detail).toBe("Stopped at 9:58 AM, started again at 10:02 AM.");
  });

  it("a restart that hasn't started again says only when it stopped", () => {
    const text = describeBlock(
      block({
        state: "restarted",
        restart: {
          reason: "update",
          stoppedAt: new Date("2026-11-10T09:58:00Z"),
          resumedAt: null,
        },
      }),
      WHEN,
      TZ
    );
    expect(text.detail).toBe("Stopped at 9:58 AM.");
  });

  it("a Windows restart has its own title", () => {
    const text = describeBlock(
      block({
        state: "restarted",
        restart: {
          reason: "windows",
          stoppedAt: new Date("2026-11-10T09:58:00Z"),
          resumedAt: new Date("2026-11-10T10:08:00Z"),
        },
      }),
      WHEN,
      TZ
    );
    expect(text.title).toBe("Restarted with Windows");
  });

  it("times are in the viewer's zone", () => {
    const text = describeBlock(
      block({
        state: "restarted",
        restart: {
          reason: "update",
          stoppedAt: new Date("2026-11-10T17:58:00Z"),
          resumedAt: null,
        },
      }),
      WHEN,
      "America/Los_Angeles"
    );
    expect(text.detail).toBe("Stopped at 9:58 AM.");
  });

  it("a missed heartbeat says how long and when it recovered", () => {
    const text = describeBlock(
      block({
        state: "missed",
        missed: {
          gapSeconds: 240,
          recoveredAt: new Date("2026-11-10T10:04:00Z"),
        },
      }),
      WHEN,
      TZ
    );
    expect(text.title).toBe("Missed a heartbeat");
    expect(text.detail).toBe(
      "Out of contact for 4 minutes, checked in again at 10:04 AM."
    );
  });

  it("unresponsive says the watcher didn't check in", () => {
    const text = describeBlock(
      block({ state: "unresponsive", heartbeats: 0 }),
      WHEN,
      TZ
    );
    expect(text.title).toBe("Unresponsive");
    expect(text.detail).toBe(
      "The watcher didn't check in during these 30 minutes."
    );
  });

  it("unresponsive, with heartbeats, says the watcher went quiet", () => {
    const text = describeBlock(
      block({ state: "unresponsive", heartbeats: 4 }),
      WHEN,
      TZ
    );
    expect(text.detail).toBe(
      "The watcher went quiet for part of these 30 minutes."
    );
  });

  it.each([
    ["future", "This part of the day hasn't happened yet."],
    ["before_first_check_in", "The watcher hadn't checked in yet."],
    ["after_deregistered", "The watcher had been deregistered."],
    ["stopped", "The watcher was stopped, so it sent nothing."],
    ["skipped", "The clocks went forward, so this half hour didn't happen."],
    ["too_soon", "Too soon to tell."],
  ] as const)("no data (%s)", (noData, detail) => {
    const text = describeBlock(
      block({ state: "no_data", noData, heartbeats: 0 }),
      WHEN,
      TZ
    );
    expect(text.title).toBe("No data");
    expect(text.detail).toBe(detail);
  });
});

describe("blockSentence", () => {
  it("reads the title, the time and the detail", () => {
    expect(
      blockSentence({
        title: "Checked in",
        when: "Tue, Nov 10, 9:30 AM to 10:00 AM",
        detail: "30 heartbeats.",
      })
    ).toBe("Checked in. Tue, Nov 10, 9:30 AM to 10:00 AM. 30 heartbeats.");
  });

  it("skips a detail that isn't there", () => {
    expect(
      blockSentence({ title: "No data", when: "Tue, Nov 10", detail: null })
    ).toBe("No data. Tue, Nov 10");
  });
});
