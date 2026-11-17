import { describe, expect, it } from "vitest";
import {
  describeEvent,
  EVENT_TYPE_OPTIONS,
  eventTypeLabel,
  runIdFromS3Key,
} from "@/lib/watchers/event-messages";

function describe_(
  eventType: string,
  message: string,
  details: unknown = null
) {
  return describeEvent({ eventType, message, details });
}

function error(
  kind: string,
  details: Record<string, unknown> = {},
  message = ""
) {
  return describe_("error", message, { kind, ...details });
}

describe("describeEvent: event types", () => {
  it("update_started", () => {
    const event = describe_(
      "update_started",
      "Upgrading watcher 1.4.1 -> 1.4.2",
      {
        current_version: "1.4.1",
        target_version: "1.4.2",
      }
    );
    expect(event.label).toBe("Update started");
    expect(event.text).toBe("Updating from 1.4.1 to 1.4.2");
    expect(event.tone).toBe("update");
  });

  it("update_succeeded", () => {
    const event = describe_(
      "update_succeeded",
      "Restarted into upgraded watcher",
      {
        previous_version: "1.4.1",
        target_version: "1.4.2",
      }
    );
    expect(event.label).toBe("Update finished");
    expect(event.text).toBe("Restarted into version 1.4.2 (was 1.4.1)");
  });

  it("update_succeeded without a previous version", () => {
    const event = describe_("update_succeeded", "", {
      target_version: "1.4.2",
    });
    expect(event.text).toBe("Restarted into version 1.4.2");
  });

  it("update_failed", () => {
    const event = describe_(
      "update_failed",
      "Watcher upgrade to 1.4.2 failed: x",
      {
        current_version: "1.4.1",
        target_version: "1.4.2",
        reason: "x",
      }
    );
    expect(event.label).toBe("Update failed");
    expect(event.tone).toBe("error");
    expect(event.text).toBe("Couldn't update from 1.4.1 to version 1.4.2");
  });

  it("update_failed from a restart check names the previous version", () => {
    const event = describe_("update_failed", "", {
      previous_version: "1.4.1",
      target_version: "1.4.2",
    });
    expect(event.text).toBe("Couldn't update from 1.4.1 to version 1.4.2");
  });

  it("watcher_started keeps the watcher's own sentence", () => {
    const event = describe_("watcher_started", "Service started on LAB-PC-01");
    expect(event.label).toBe("Started");
    expect(event.text).toBe("Service started on LAB-PC-01");
  });

  it("watcher_started after a settings change", () => {
    expect(
      describe_(
        "watcher_started",
        "Service restarted on LAB-PC-01 with config revision 3"
      ).text
    ).toBe("Service restarted on LAB-PC-01 to apply settings revision 3");
    expect(
      describe_(
        "watcher_started",
        "Watcher restarted on LAB-PC-01 with its previous config"
      ).text
    ).toBe("Watcher restarted on LAB-PC-01 with its previous settings");
  });

  it("file_uploaded names the file and lists what is known about it", () => {
    const event = describe_("file_uploaded", "Uploaded plate-1.csv", {
      s3_key: "plate-reader-a/run-0001/plate-1.csv",
      size_bytes: 3_984_588,
      part_count: 1,
    });
    expect(event.label).toBe("File uploaded");
    expect(event.tone).toBe("success");
    expect(event.text).toBe("Uploaded plate-1.csv");
    expect(event.message).toEqual([
      { kind: "text", text: "Uploaded " },
      { kind: "file", name: "plate-1.csv" },
    ]);
    expect(event.facts).toEqual([
      { kind: "value", label: "Size", value: "3.8 MB" },
      { kind: "run", runId: "run-0001" },
      { kind: "note", text: "Uploaded in one part" },
    ]);
  });

  it("file_uploaded in several parts, with no message to read the name from", () => {
    const event = describe_("file_uploaded", "", {
      s3_key: "plate-reader-a/run-0001/big.nd2",
      part_count: 4,
    });
    expect(event.text).toBe("Uploaded big.nd2");
    expect(event.facts).toEqual([
      { kind: "run", runId: "run-0001" },
      { kind: "note", text: "Uploaded in 4 parts" },
    ]);
  });

  it("file_uploaded without details still reads as a sentence", () => {
    expect(describe_("file_uploaded", "").text).toBe("Uploaded a file");
  });

  it("run_reported links the run", () => {
    const event = describe_("run_reported", "Run run-0001 reported", {
      run_id: "run-0001",
    });
    expect(event.label).toBe("Run reported");
    expect(event.message).toEqual([
      { kind: "text", text: "Run " },
      { kind: "run", runId: "run-0001" },
      { kind: "text", text: " reported" },
    ]);
  });

  it("run_reported reads the run from the message when details lack it", () => {
    expect(
      describe_("run_reported", "Run run-0002 reported").message[1]
    ).toEqual({
      kind: "run",
      runId: "run-0002",
    });
  });

  describe("watcher_stopped", () => {
    it.each([
      [
        "Service restarting for auto-update",
        "Service stopped to install an update",
      ],
      [
        "Watcher restarting for auto-update",
        "Watcher stopped to install an update",
      ],
      [
        "Service stopped: Windows is shutting down",
        "Service stopped because Windows is restarting or shutting down",
      ],
      [
        "Service stopped: its registration was deleted on Data Hub",
        "Service stopped because it was deregistered on Data Hub",
      ],
      ["Watcher stopped by user", "Watcher stopped by someone on the PC"],
      ["Service stopped", "Service stopped"],
    ])("%s", (message, text) => {
      const event = describe_("watcher_stopped", message);
      expect(event.label).toBe("Stopped");
      expect(event.text).toBe(text);
    });

    it("a plain stop that the final heartbeat marked as an update", () => {
      // The upgrade worker stops the Windows service from outside, so the
      // event's own message can't say why.
      const event = describe_("watcher_stopped", "Service stopped", {
        stop_reason: "auto_update",
      });
      expect(event.text).toBe("Service stopped to install an update");
    });

    it("a plain stop that the final heartbeat marked as a Windows shutdown", () => {
      const event = describe_("watcher_stopped", "Service stopped", {
        stop_reason: "system_shutdown",
      });
      expect(event.text).toBe(
        "Service stopped because Windows is restarting or shutting down"
      );
    });

    it("a plain stop that follows an update handed to the upgrade worker", () => {
      const event = describeEvent({
        eventType: "watcher_stopped",
        message: "Service stopped",
        details: null,
        afterUpdateStart: true,
      });
      expect(event.text).toBe("Service stopped to install an update");
    });

    it("a stop by someone is not an update stop, even after an update began", () => {
      const event = describeEvent({
        eventType: "watcher_stopped",
        message: "Watcher stopped by user",
        details: null,
        afterUpdateStart: true,
      });
      expect(event.text).toBe("Watcher stopped by someone on the PC");
    });

    it("an environment switch", () => {
      const event = describe_(
        "watcher_stopped",
        "Environment switched: staging -> production",
        {
          from: "staging",
          to: "production",
        }
      );
      expect(event.text).toBe(
        "Switched from the staging environment to production"
      );
    });

    it("the server's own note about cancelled uploads is not a stop", () => {
      const event = describe_(
        "watcher_stopped",
        "Reverted 2 pending upload request(s) — no online watcher to upload them",
        {
          kind: "upload_requests_cancelled",
          reason: "watcher_stopped",
          cancelled_count: 2,
        }
      );
      expect(event.label).toBe("Uploads cancelled");
      expect(event.text).toBe(
        "Cancelled 2 requested uploads because the watcher stopped"
      );
    });
  });

  describe("upload_failed", () => {
    it("a file that can't be read yet is waited for", () => {
      const event = describe_(
        "upload_failed",
        "Can't read a.csv yet (locked).",
        {
          will_retry: true,
          relative_path: "sub/a.csv",
          run_id: "run-0001",
        }
      );
      expect(event.label).toBe("File not ready");
      expect(event.tone).toBe("warning");
      expect(event.text).toBe(
        "sub/a.csv can't be read yet. The watcher will try again."
      );
      expect(event.facts).toEqual([{ kind: "run", runId: "run-0001" }]);
    });

    it.each([
      ["Upload failed: a.csv", "Couldn't upload a.csv"],
      [
        "Presigned URL request failed: a.csv",
        "Couldn't start the upload of a.csv",
      ],
      ["Hashing failed: a.csv", "Couldn't read a.csv to prepare the upload"],
      [
        "Upload notification failed: a.csv",
        "Uploaded a.csv, but couldn't tell Data Hub it arrived",
      ],
    ])("%s", (message, text) => {
      const event = describe_("upload_failed", message, { error: "boom" });
      expect(event.label).toBe("Upload failed");
      expect(event.tone).toBe("error");
      expect(event.text).toBe(text);
    });

    it("shows the run and the error of a failed upload, from its S3 key", () => {
      const event = describe_("upload_failed", "Upload failed: a.csv", {
        s3_key: "plate-reader/run-0001/a.csv",
        error: "Connection reset",
      });
      expect(event.facts).toEqual([
        { kind: "run", runId: "run-0001" },
        { kind: "value", label: "Error", value: "Connection reset" },
      ]);
    });

    it("prefers a run ID in the details to the one in the S3 key", () => {
      const event = describe_("upload_failed", "Upload failed: a.csv", {
        run_id: "run-0002",
        s3_key: "plate-reader/run-0001/a.csv",
      });
      expect(event.facts).toEqual([{ kind: "run", runId: "run-0002" }]);
    });

    it("a refusal because the run was deleted links the run", () => {
      const event = describe_(
        "upload_failed",
        "Upload refused: run run-0001 was deleted on Data Hub",
        { reason: "run_deleted", run_id: "run-0001" }
      );
      expect(event.text).toBe(
        "Upload refused: run run-0001 was deleted on Data Hub"
      );
      expect(event.message).toContainEqual({ kind: "run", runId: "run-0001" });
    });

    it("anything else keeps the watcher's words", () => {
      expect(describe_("upload_failed", "Something odd").text).toBe(
        "Something odd"
      );
    });
  });

  describe("config_synced", () => {
    it("an applied revision", () => {
      const event = describe_("config_synced", "Applied config revision 3", {
        kind: "config_revision_applied",
        revision: 3,
      });
      expect(event.label).toBe("Settings applied");
      expect(event.text).toBe("Applied settings revision 3");
    });

    it.each([
      [
        "startup",
        "Sent the settings file to Data Hub when the watcher started",
      ],
      [
        "init",
        "Sent the settings file to Data Hub when the watcher was set up",
      ],
      [
        "edit",
        "Sent the settings file to Data Hub after the settings file was edited",
      ],
      [
        "open",
        "Sent the settings file to Data Hub after the settings file was opened",
      ],
      [
        "env-switch",
        "Sent the settings file to Data Hub after the watcher switched environment",
      ],
      [
        "config_revision",
        "Sent the settings file to Data Hub to apply a settings change",
      ],
      ["something-new", "Sent the settings file to Data Hub"],
    ])("a push on %s", (trigger, text) => {
      const event = describe_(
        "config_synced",
        `Config synced (trigger=${trigger})`,
        { trigger }
      );
      expect(event.label).toBe("Settings synced");
      expect(event.text).toBe(text);
    });

    it("a change of watch folder cancels requested uploads", () => {
      const event = describe_(
        "config_synced",
        "Cancelled 3 pending upload request(s)",
        {
          kind: "upload_requests_cancelled",
          cancelled_count: 3,
          previous_watch_directory: "D:\\Old",
          watch_directory: "D:\\New",
        }
      );
      expect(event.label).toBe("Uploads cancelled");
      expect(event.text).toBe(
        "Cancelled 3 requested uploads because the watch folder changed"
      );
      expect(event.facts).toEqual([
        { kind: "value", label: "Was", value: "D:\\Old" },
        { kind: "value", label: "Now", value: "D:\\New" },
      ]);
    });

    it("a message with no details is kept", () => {
      expect(describe_("config_synced", "Config synced from server").text).toBe(
        "Config synced from server"
      );
    });
  });

  describe("uploads_failed", () => {
    it("says how many files couldn't upload, links the run and names the folder", () => {
      const event = describe_("uploads_failed", "", {
        kind: "uploads_failed",
        run_id: "run-0001",
        reason: "folder_missing",
        folder: "projects/run-0001",
        failed_count: 129,
      });
      expect(event.label).toBe("Couldn't upload");
      expect(event.tone).toBe("error");
      expect(event.text).toBe(
        "Couldn't upload 129 files in run run-0001: folder no longer on the instrument PC"
      );
      expect(event.message).toContainEqual({ kind: "run", runId: "run-0001" });
      expect(event.facts).toContainEqual({
        kind: "value",
        label: "Folder",
        value: "projects/run-0001",
      });
    });

    it("falls back to the stored message for a reason it doesn't know", () => {
      const event = describe_("uploads_failed", "Couldn't upload 2 files", {
        kind: "uploads_failed",
        run_id: "run-0001",
        reason: "something_new",
        failed_count: 2,
      });
      expect(event.label).toBe("Couldn't upload");
      expect(event.text).toBe("Couldn't upload 2 files");
    });
  });

  describe("upload_requests_cancelled", () => {
    it("a deleted run links the run", () => {
      const event = describe_("upload_requests_cancelled", "", {
        kind: "upload_requests_cancelled",
        reason: "run_deleted",
        run_id: "run-0001",
        cancelled_count: 1,
      });
      expect(event.label).toBe("Uploads cancelled");
      expect(event.text).toBe(
        "Cancelled 1 requested upload because run run-0001 was deleted"
      );
      expect(event.message).toContainEqual({ kind: "run", runId: "run-0001" });
    });

    it.each([
      ["watcher_deregistered", "the watcher was deregistered"],
      ["instrument_retired", "the instrument was retired"],
      ["watcher_offline_sweep", "the watcher stopped checking in"],
    ])("%s", (reason, because) => {
      const event = describe_("error", "", {
        kind: "upload_requests_cancelled",
        reason,
        cancelled_count: 2,
      });
      expect(event.label).toBe("Uploads cancelled");
      expect(event.text).toBe(
        `Cancelled 2 requested uploads because ${because}`
      );
    });
  });

  it("an event type added later gets a label written from its name", () => {
    const event = describe_("upload_queue_drained", "");
    expect(event.label).toBe("Upload queue drained");
    expect(event.text).toBe("Upload queue drained");
  });

  it("an event type added later keeps the watcher's message", () => {
    const event = describe_("some_new_type", "Something happened.");
    expect(event.label).toBe("Some new type");
    expect(event.text).toBe("Something happened.");
  });
});

describe("describeEvent: error kinds", () => {
  it("heartbeat_recovered is a missed heartbeat", () => {
    const event = error("heartbeat_recovered", {
      consecutive_failures: 1,
      gap_seconds: 61,
    });
    expect(event.label).toBe("Missed heartbeat");
    expect(event.text).toBe("Checked in again after missing 1 heartbeat");
    expect(event.facts).toEqual([
      { kind: "value", label: "Out of contact for", value: "2 minutes" },
    ]);
  });

  it("heartbeat_recovered after several misses", () => {
    expect(error("heartbeat_recovered", { consecutive_failures: 3 }).text).toBe(
      "Checked in again after missing 3 heartbeats"
    );
  });

  it("run_report_failed", () => {
    expect(error("run_report_failed", { run_id: "run-0001" }).text).toBe(
      "Couldn't report run run-0001 to Data Hub"
    );
    const deleted = error("run_report_failed", {
      run_id: "run-0001",
      reason: "run_deleted",
    });
    expect(deleted.text).toBe(
      "Run run-0001 was deleted on Data Hub, so its files aren't reported"
    );
    expect(deleted.facts).toEqual([{ kind: "run", runId: "run-0001" }]);
  });

  it("state_write_failed", () => {
    const event = error("state_write_failed", { run_id: "run-0001" });
    expect(event.label).toBe("Couldn't save");
    expect(event.text).toBe(
      "Couldn't save run run-0001 on the PC. The watcher will try again."
    );
  });

  it("config_sync_failed", () => {
    const event = error("config_sync_failed", { checksum: "abc", error: "x" });
    expect(event.label).toBe("Settings sync failed");
    expect(event.text).toBe("Couldn't send the settings file to Data Hub");
  });

  it("stability_timeout", () => {
    const event = error("stability_timeout", {
      path: "D:\\Data\\run\\big.nd2",
      max_wait_seconds: 600,
    });
    expect(event.label).toBe("File skipped");
    expect(event.text).toBe(
      "big.nd2 kept changing for over 10 minutes, so the watcher skipped it"
    );
  });

  it("stable_callback_failed", () => {
    const event = error("stable_callback_failed", { path: "/data/a.csv" });
    expect(event.label).toBe("File not processed");
    expect(event.text).toBe("The watcher couldn't process a.csv");
  });

  it("pattern_mismatch", () => {
    const event = error("pattern_mismatch", { relative_path: "sub/a.csv" });
    expect(event.label).toBe("File skipped");
    expect(event.text).toBe(
      "sub/a.csv doesn't match the run pattern, so the watcher skipped it"
    );
  });

  it("events_dropped", () => {
    expect(error("events_dropped", { dropped_count: 1 }).text).toBe(
      "1 watcher event didn't reach Data Hub"
    );
    expect(error("events_dropped", { dropped_count: 12 }).text).toBe(
      "12 watcher events didn't reach Data Hub"
    );
    expect(error("events_dropped").label).toBe("Events lost");
  });

  it("upload_queue_poll_failed", () => {
    const event = error("upload_queue_poll_failed", {
      consecutive_failures: 10,
    });
    expect(event.label).toBe("Upload check failed");
    expect(event.text).toBe(
      "Couldn't ask Data Hub for requested uploads (10 times in a row)"
    );
    expect(
      error("upload_queue_poll_failed", { consecutive_failures: 1 }).text
    ).toBe("Couldn't ask Data Hub for requested uploads");
  });

  it("update_check_failed", () => {
    const event = error("update_check_failed", { consecutive_failures: 3 });
    expect(event.label).toBe("Update check failed");
    expect(event.text).toBe(
      "Couldn't check for a new watcher version (3 times in a row)"
    );
  });

  it("queued_file_missing", () => {
    const event = error(
      "queued_file_missing",
      { expected_path: "D:\\Data\\a.csv" },
      "Queued file missing: a.csv"
    );
    expect(event.label).toBe("File missing");
    expect(event.text).toBe("Can't find a.csv on the PC to upload it");
    expect(
      error("queued_file_missing", { expected_path: "D:\\Data\\b.csv" }).text
    ).toBe("Can't find b.csv on the PC to upload it");
  });

  it("upload_request_cancelled", () => {
    const event = error("upload_request_cancelled", { attempts: 3 });
    expect(event.label).toBe("Upload request dropped");
    expect(event.text).toBe(
      "The watcher gave up on a requested upload after 3 tries"
    );
  });

  it("upload_retries_exhausted", () => {
    const event = error("upload_retries_exhausted", {
      relative_path: "a.csv",
      run_id: "run-0001",
    });
    expect(event.label).toBe("Upload gave up");
    expect(event.text).toBe("Stopped trying to upload a.csv");
    expect(event.facts).toEqual([{ kind: "run", runId: "run-0001" }]);
  });

  it("pending_upload_missing", () => {
    const event = error("pending_upload_missing", { relative_path: "a.csv" });
    expect(event.label).toBe("File missing");
    expect(event.text).toBe(
      "a.csv was waiting to upload, but it is no longer on the PC"
    );
  });

  it("watch_directory_unavailable", () => {
    const event = error("watch_directory_unavailable", {
      watch_directory: "D:\\Exports",
      reason: "watch_directory not found",
    });
    expect(event.label).toBe("Folder not found");
    expect(event.tone).toBe("warning");
    expect(event.text).toBe(
      "The watch folder D:\\Exports isn't available. The watcher is waiting for it."
    );
  });

  it("unsafe_upload_path", () => {
    const event = error("unsafe_upload_path", { file_id: 1 });
    expect(event.label).toBe("Upload refused");
    expect(event.text).toBe(
      "Refused to upload a file whose path leads outside the watch folder"
    );
  });

  it("config_revision_rejected", () => {
    const event = error("config_revision_rejected", {
      revision: 2,
      reason: "The watcher could not read the new watch folder on this PC.",
    });
    expect(event.label).toBe("Settings rejected");
    expect(event.text).toBe(
      "The watcher rejected settings revision 2. The watcher could not read the new watch folder on this PC."
    );
    expect(
      error("config_revision_rejected", { revision: 2, reason: null }).text
    ).toBe("The watcher rejected settings revision 2");
  });

  it("an error of another kind keeps the watcher's own message", () => {
    const event = error("brand_new_kind", {}, "The watcher's own words.");
    expect(event.label).toBe("Error");
    expect(event.tone).toBe("error");
    expect(event.text).toBe("The watcher's own words.");
  });

  it("an error with no message and an unknown kind reads as words, not snake_case", () => {
    expect(error("brand_new_kind").text).toBe("Brand new kind");
  });

  it("an error with no kind keeps the message", () => {
    const event = describe_("error", "Disk is full", null);
    expect(event.label).toBe("Error");
    expect(event.text).toBe("Disk is full");
  });
});

describe("describeEvent: never shows a raw name", () => {
  const SNAKE_CASE = /\b[a-z]+_[a-z_]+\b/;
  const kinds = [
    "run_report_failed",
    "state_write_failed",
    "config_sync_failed",
    "stability_timeout",
    "stable_callback_failed",
    "pattern_mismatch",
    "events_dropped",
    "heartbeat_recovered",
    "upload_queue_poll_failed",
    "update_check_failed",
    "queued_file_missing",
    "upload_request_cancelled",
    "upload_retries_exhausted",
    "pending_upload_missing",
    "watch_directory_unavailable",
    "unsafe_upload_path",
    "config_revision_rejected",
    "upload_requests_cancelled",
    "a_kind_nobody_wrote_yet",
  ];

  it.each(kinds)("an error of kind %s with no details", (kind) => {
    const event = error(kind);
    expect(event.label).not.toMatch(SNAKE_CASE);
    expect(event.text).not.toMatch(SNAKE_CASE);
  });

  it.each(
    EVENT_TYPE_OPTIONS.map((option) => option.value)
  )("an event of type %s with no message or details", (type) => {
    const event = describe_(type, "");
    expect(event.label).not.toMatch(SNAKE_CASE);
    expect(event.text).not.toMatch(SNAKE_CASE);
    expect(event.text.length).toBeGreaterThan(0);
  });
});

describe("eventTypeLabel", () => {
  it("labels every type the filter offers", () => {
    expect(EVENT_TYPE_OPTIONS.map((option) => option.value)).toEqual([
      "watcher_started",
      "watcher_stopped",
      "file_uploaded",
      "upload_failed",
      "run_reported",
      "config_synced",
      "error",
      "update_started",
      "update_succeeded",
      "update_failed",
      "upload_requests_cancelled",
      "uploads_failed",
    ]);
    expect(eventTypeLabel("update_succeeded")).toBe("Update finished");
  });

  it("writes an unlisted type from its name", () => {
    expect(eventTypeLabel("queue_stalled")).toBe("Queue stalled");
  });
});

describe("runIdFromS3Key", () => {
  it("reads the run between the instrument and the file", () => {
    expect(runIdFromS3Key("plate-reader-a/run-0001/a.csv")).toBe("run-0001");
  });

  it("keeps a run ID that has spaces and a dash", () => {
    expect(runIdFromS3Key("tape/2026-03-15 - 09-15-22-gDNA/a.csv")).toBe(
      "2026-03-15 - 09-15-22-gDNA"
    );
  });

  it("is null for a key that isn't <instrument>/<run>/<file>", () => {
    expect(runIdFromS3Key("a.csv")).toBeNull();
    expect(runIdFromS3Key("plate/a.csv")).toBeNull();
    expect(runIdFromS3Key(null)).toBeNull();
  });
});
