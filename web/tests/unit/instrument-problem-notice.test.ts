import { describe, expect, it } from "vitest";
import {
  CONNECTION_REASONS,
  type Connection,
  type InstrumentLifecycleStatus,
} from "@/lib/instruments/connection";
import {
  formatLastCheckIn,
  instrumentProblemNotice,
  type ProblemNotice,
  type ProblemNoticeInput,
} from "@/lib/instruments/problem-notice";

// Each offline reason has its own title, sentence and actions, and the actions
// depend on who is looking. Only an Offline badge gets a notice at all.

const NOW = new Date("2026-11-12T15:00:00.000Z");
const ZONE = "UTC";

const WATCHER = {
  hostname: "LAB-PC-01",
  lastHeartbeatAt: new Date("2026-11-12T11:14:00.000Z"),
  watchDirectory: "C:\\Data\\Plate Reader A",
};

function offline(reason: Connection["reason"]): Connection {
  return { state: "offline", reason };
}

function notice(
  overrides: Partial<ProblemNoticeInput> & { connection: Connection }
): ProblemNotice | null {
  return instrumentProblemNotice({
    status: "active",
    isAdmin: false,
    timeZone: ZONE,
    now: NOW,
    watcher: WATCHER,
    ...overrides,
  });
}

/** The sentence as one string, with a folder or computer name inline. */
function bodyText(n: ProblemNotice): string {
  return n.body
    .map((part) => (typeof part === "string" ? part : part.code))
    .join("");
}

describe("instrumentProblemNotice by reason", () => {
  it("folder_missing names the folder, and lets admins change it", () => {
    const admin = notice({
      connection: offline("folder_missing"),
      isAdmin: true,
    });
    const member = notice({ connection: offline("folder_missing") });

    expect(admin?.title).toBe("New files aren't being picked up");
    expect(admin && bodyText(admin)).toBe(
      "The watcher can't find C:\\Data\\Plate Reader A, so it isn't picking up new files from this instrument."
    );
    // The folder is its own part, so the page can set it in monospace.
    expect(admin?.body).toContainEqual({ code: "C:\\Data\\Plate Reader A" });
    expect(admin?.actions).toEqual(["change_folder", "see_details"]);

    expect(member?.title).toBe("New files aren't being picked up");
    expect(member?.actions).toEqual(["see_details"]);
  });

  it("folder_missing still reads when the folder isn't known", () => {
    const n = notice({
      connection: offline("folder_missing"),
      watcher: { ...WATCHER, watchDirectory: null },
    });
    expect(n && bodyText(n)).toBe(
      "The watcher can't find its watch folder, so it isn't picking up new files from this instrument."
    );
  });

  it("unresponsive says when the watcher last checked in, for admins and members", () => {
    for (const isAdmin of [true, false]) {
      const n = notice({ connection: offline("unresponsive"), isAdmin });
      expect(n?.title).toBe("The watcher isn't checking in");
      expect(n && bodyText(n)).toBe(
        "The watcher for this instrument hasn't checked in since today at 11:14 AM. New files won't appear here until it's back."
      );
      // Admins get no extra action here: there is nothing to change in Data Hub.
      expect(n?.actions).toEqual(["see_details"]);
    }
  });

  it("unresponsive drops the time when there was never a heartbeat", () => {
    const n = notice({
      connection: offline("unresponsive"),
      watcher: { ...WATCHER, lastHeartbeatAt: null },
    });
    expect(n && bodyText(n)).toBe(
      "The watcher for this instrument hasn't checked in. New files won't appear here until it's back."
    );
  });

  it("never_checked_in names the computer and what to check, for admins and members", () => {
    for (const isAdmin of [true, false]) {
      const n = notice({
        connection: offline("never_checked_in"),
        isAdmin,
        watcher: { ...WATCHER, lastHeartbeatAt: null },
      });
      expect(n?.title).toBe("The watcher never checked in");
      expect(n && bodyText(n)).toBe(
        "The watcher on LAB-PC-01 was set up but has never checked in. New files won't appear until the watcher service is running on that PC and can reach Data Hub."
      );
      expect(n?.body).toContainEqual({ code: "LAB-PC-01" });
      expect(n?.actions).toEqual(["see_details"]);
    }
  });

  it("never_checked_in still reads when the computer isn't known", () => {
    const n = notice({
      connection: offline("never_checked_in"),
      watcher: { ...WATCHER, hostname: null, lastHeartbeatAt: null },
    });
    expect(n && bodyText(n)).toBe(
      "The watcher was set up but has never checked in. New files won't appear until the watcher service is running on that PC and can reach Data Hub."
    );
  });

  it("stopped names the computer, for admins and members", () => {
    for (const isAdmin of [true, false]) {
      const n = notice({ connection: offline("stopped"), isAdmin });
      expect(n?.title).toBe("Uploads from this instrument are paused");
      expect(n && bodyText(n)).toBe(
        "The watcher on LAB-PC-01 was stopped. New files won't appear until it's started again."
      );
      expect(n?.body).toContainEqual({ code: "LAB-PC-01" });
      expect(n?.actions).toEqual(["see_details"]);
    }
  });

  it("stopped still reads when the computer isn't known", () => {
    const n = notice({
      connection: offline("stopped"),
      watcher: { ...WATCHER, hostname: null },
    });
    expect(n && bodyText(n)).toBe(
      "The watcher was stopped. New files won't appear until it's started again."
    );
  });

  it("no_watcher tells admins to connect one, and members nothing to do", () => {
    const admin = notice({
      connection: offline("no_watcher"),
      isAdmin: true,
      watcher: null,
    });
    const member = notice({ connection: offline("no_watcher"), watcher: null });

    for (const n of [admin, member]) {
      expect(n?.title).toBe("This instrument isn't connected to a watcher");
      expect(n && bodyText(n)).toBe(
        "New files won't appear until a watcher is set up on the instrument PC."
      );
    }
    expect(admin?.actions).toEqual(["connect_watcher"]);
    // No watcher means no details to see.
    expect(member?.actions).toEqual([]);
  });

  it("deregistered says when and by whom, and tells admins to connect a new one", () => {
    const deregistration = {
      at: new Date("2026-11-09T16:30:00.000Z"),
      byName: "Alice Example",
    };
    const admin = notice({
      connection: offline("deregistered"),
      isAdmin: true,
      watcher: null,
      deregistration,
    });
    const member = notice({
      connection: offline("deregistered"),
      watcher: null,
      deregistration,
    });

    for (const n of [admin, member]) {
      expect(n?.title).toBe("This instrument isn't connected to a watcher");
      expect(n && bodyText(n)).toBe(
        "Its watcher was deregistered on Nov 9 by Alice Example. New files won't appear until a new watcher is set up."
      );
    }
    expect(admin?.actions).toEqual(["connect_watcher"]);
    expect(member?.actions).toEqual([]);
  });

  it("deregistered leaves out a name that wasn't recorded, and a missing date", () => {
    const noName = notice({
      connection: offline("deregistered"),
      watcher: null,
      deregistration: {
        at: new Date("2025-03-02T10:00:00.000Z"),
        byName: null,
      },
    });
    // A date in another year carries the year.
    expect(noName && bodyText(noName)).toBe(
      "Its watcher was deregistered on Mar 2, 2025. New files won't appear until a new watcher is set up."
    );

    const nothing = notice({
      connection: offline("deregistered"),
      watcher: null,
      deregistration: null,
    });
    expect(nothing && bodyText(nothing)).toBe(
      "Its watcher was deregistered. New files won't appear until a new watcher is set up."
    );
  });

  it("has an answer for every reason a connection can give", () => {
    for (const reason of CONNECTION_REASONS) {
      for (const isAdmin of [true, false]) {
        const n = notice({ connection: offline(reason), isAdmin });
        expect(n, `${reason} (admin: ${isAdmin})`).not.toBeNull();
        expect(n?.title).toBeTruthy();
      }
    }
  });
});

describe("instrumentProblemNotice is quiet unless the badge is Offline", () => {
  it("shows nothing for Online, Restarting and Connecting", () => {
    for (const state of ["online", "restarting", "connecting"] as const) {
      for (const isAdmin of [true, false]) {
        expect(
          notice({ connection: { state, reason: null }, isAdmin }),
          `${state} (admin: ${isAdmin})`
        ).toBeNull();
      }
    }
  });

  it("shows nothing for a Pending or Retired instrument, whatever its connection", () => {
    // Pending and Retired win over the connection. A retired instrument has
    // no watcher, which would otherwise read as a problem to fix.
    for (const status of [
      "pending",
      "inactive",
    ] as const satisfies readonly InstrumentLifecycleStatus[]) {
      for (const reason of CONNECTION_REASONS) {
        expect(
          notice({ status, connection: offline(reason), isAdmin: true }),
          `${status} / ${reason}`
        ).toBeNull();
      }
    }
  });

  it("shows nothing for an offline connection with no reason", () => {
    expect(notice({ connection: offline(null) })).toBeNull();
  });
});

describe("formatLastCheckIn", () => {
  const at = (iso: string) => new Date(iso);

  it("says today, yesterday, or the date, with the time", () => {
    expect(formatLastCheckIn(at("2026-11-12T11:14:00Z"), ZONE, NOW)).toBe(
      "today at 11:14 AM"
    );
    expect(formatLastCheckIn(at("2026-11-11T23:59:00Z"), ZONE, NOW)).toBe(
      "yesterday at 11:59 PM"
    );
    expect(formatLastCheckIn(at("2026-11-02T08:05:00Z"), ZONE, NOW)).toBe(
      "Nov 2 at 8:05 AM"
    );
    expect(formatLastCheckIn(at("2025-12-30T08:05:00Z"), ZONE, NOW)).toBe(
      "Dec 30, 2025 at 8:05 AM"
    );
  });

  it("counts days in the viewer's zone", () => {
    // 02:30 UTC on Nov 12 is still Nov 11 in Los Angeles, so it is yesterday
    // there when it is 15:00 UTC (07:00 in Los Angeles) on Nov 12.
    expect(
      formatLastCheckIn(at("2026-11-12T02:30:00Z"), "America/Los_Angeles", NOW)
    ).toBe("yesterday at 6:30 PM");
    expect(formatLastCheckIn(at("2026-11-12T02:30:00Z"), ZONE, NOW)).toBe(
      "today at 2:30 AM"
    );
  });
});
