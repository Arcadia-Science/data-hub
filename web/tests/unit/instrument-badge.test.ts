import { Clock, Power, Radio, RefreshCw, WifiOff } from "lucide-react";
import { describe, expect, it } from "vitest";
import {
  INSTRUMENT_BADGE_CONFIG,
  instrumentBadgeSentence,
} from "@/components/instruments/instrument-badge-config";
import type { InstrumentBadgeState } from "@/lib/instruments/connection";

// The badge's six states, from the design's badge board and the copy deck.

const STATES: InstrumentBadgeState[] = [
  "online",
  "restarting",
  "connecting",
  "offline",
  "pending",
  "retired",
];

describe("INSTRUMENT_BADGE_CONFIG", () => {
  it("has the label and icon of each state on the badge board", () => {
    expect(
      Object.fromEntries(
        STATES.map((s) => [
          s,
          [INSTRUMENT_BADGE_CONFIG[s].label, INSTRUMENT_BADGE_CONFIG[s].Icon],
        ])
      )
    ).toEqual({
      online: ["Online", Radio],
      restarting: ["Restarting", RefreshCw],
      connecting: ["Connecting", Clock],
      offline: ["Offline", WifiOff],
      pending: ["Pending", Clock],
      retired: ["Retired", Power],
    });
  });

  it("covers exactly the six states, and gives each a light and a dark color", () => {
    expect(Object.keys(INSTRUMENT_BADGE_CONFIG).sort()).toEqual(
      [...STATES].sort()
    );
    for (const state of STATES) {
      const { className } = INSTRUMENT_BADGE_CONFIG[state];
      expect(className, state).toMatch(/\bbg-/);
      expect(className, state).toMatch(/\btext-/);
      expect(className, state).toMatch(/\bdark:bg-/);
      expect(className, state).toMatch(/\bdark:text-/);
    }
  });

  it("colors Online green, Offline red, Pending amber, and the rest slate", () => {
    const color = (s: InstrumentBadgeState) =>
      INSTRUMENT_BADGE_CONFIG[s].className;
    expect(color("online")).toContain("bg-green-100");
    expect(color("offline")).toContain("bg-red-100");
    expect(color("pending")).toContain("bg-amber-100");
    expect(color("restarting")).toContain("bg-slate-100");
    expect(color("connecting")).toContain("bg-slate-100");
    expect(color("retired")).toContain("bg-slate-600");
  });
});

describe("instrumentBadgeSentence", () => {
  it("gives each state its sentence from the copy deck", () => {
    expect(
      Object.fromEntries(STATES.map((s) => [s, instrumentBadgeSentence(s)]))
    ).toEqual({
      online: "New files upload automatically.",
      restarting:
        "The instrument PC is restarting or updating. This usually takes a minute or two.",
      connecting: "The watcher was just set up and hasn't checked in yet.",
      offline: "New files won't appear right now.",
      pending: "Waiting for an admin to confirm this instrument.",
      retired:
        "This instrument no longer takes new runs. Its runs stay browsable.",
    });
  });

  it("reads Online differently in manual upload mode", () => {
    expect(instrumentBadgeSentence("online", "auto")).toBe(
      "New files upload automatically."
    );
    expect(instrumentBadgeSentence("online", "manual")).toBe(
      "New files upload when someone requests them."
    );
  });

  it("treats a missing upload mode as automatic", () => {
    expect(instrumentBadgeSentence("online")).toBe(
      "New files upload automatically."
    );
  });

  it("changes no other state in manual upload mode", () => {
    for (const state of STATES.filter((s) => s !== "online")) {
      expect(instrumentBadgeSentence(state, "manual"), state).toBe(
        instrumentBadgeSentence(state, "auto")
      );
    }
  });
});
