// Plain-language labels and messages for the watcher's events, so the Activity
// tab never shows a raw event type, a `details.kind` or a developer's message
// where a sentence will do. One pure function, `describeEvent`, covers every
// event type in `watcherEventTypeEnum` and every `details.kind` that the
// watcher (`watcher/src/data_hub_watcher/events.py`) or the server writes. No
// database imports, so server pages and client rows share it.

import { formatBytes } from "@/lib/utils";
import { baseName, describeDuration, pluralize, sentenceCase } from "./phrases";
import {
  restartReasonOf,
  UPLOAD_REQUESTS_CANCELLED_KIND,
} from "./stop-reasons";

/** What the label pill looks like. */
export type EventTone =
  | "success"
  | "info"
  | "update"
  | "neutral"
  | "muted"
  | "warning"
  | "error";

/** A piece of a message: plain words, a file name or a run ID that links. */
export type MessagePart =
  | { kind: "text"; text: string }
  | { kind: "file"; name: string }
  | { kind: "run"; runId: string };

/** A detail shown when the row is open. The row adds the exact time. */
export type EventFact =
  | { kind: "value"; label: string; value: string }
  | { kind: "run"; runId: string }
  | { kind: "note"; text: string };

export interface EventDescription {
  facts: EventFact[];
  label: string;
  message: MessagePart[];
  /** The message as one string, for tests and screen readers. */
  text: string;
  tone: EventTone;
}

export interface EventInput {
  /**
   * For a stop: whether it follows an update handed to the upgrade worker, which
   * only a query over the neighbouring events can tell (`restartReasonOf`).
   */
  afterUpdateStart?: boolean;
  details: unknown;
  eventType: string;
  message: string;
}

/** The event types a person can filter by, in the order the filter lists them. */
export const EVENT_TYPE_OPTIONS = [
  { value: "watcher_started", label: "Started" },
  { value: "watcher_stopped", label: "Stopped" },
  { value: "file_uploaded", label: "File uploaded" },
  { value: "upload_failed", label: "Upload failed" },
  { value: "run_reported", label: "Run reported" },
  { value: "config_synced", label: "Settings synced" },
  { value: "error", label: "Error" },
  { value: "update_started", label: "Update started" },
  { value: "update_succeeded", label: "Update finished" },
  { value: "update_failed", label: "Update failed" },
  { value: "upload_requests_cancelled", label: "Uploads cancelled" },
] as const;

/** The label for an event type, written from its name when it isn't listed. */
export function eventTypeLabel(eventType: string): string {
  return (
    EVENT_TYPE_OPTIONS.find((option) => option.value === eventType)?.label ??
    sentenceCase(eventType)
  );
}

// ---------------------------------------------------------------------------
// Reading `details`, which the watcher fills as it likes
// ---------------------------------------------------------------------------

type Details = Record<string, unknown>;

function asDetails(details: unknown): Details {
  return typeof details === "object" && details !== null
    ? (details as Details)
    : {};
}

function text(details: Details, key: string): string | null {
  const value = details[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function whole(details: Details, key: string): number | null {
  const value = details[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Building a message
// ---------------------------------------------------------------------------

const t = (value: string): MessagePart => ({ kind: "text", text: value });
const file = (name: string): MessagePart => ({ kind: "file", name });
const run = (runId: string): MessagePart => ({ kind: "run", runId });

function partsToText(parts: MessagePart[]): string {
  return parts
    .map((part) => {
      switch (part.kind) {
        case "text":
          return part.text;
        case "file":
          return part.name;
        case "run":
          return part.runId;
        default:
          return part satisfies never;
      }
    })
    .join("");
}

interface Described {
  facts?: EventFact[];
  label: string;
  message: MessagePart[];
  tone: EventTone;
}

/** The key is the instrument's slug, the run's ID and the file's stored name. */
const RUN_IN_S3_KEY = /^[^/]*\/(.+)\/[^/]*$/;

/**
 * The run ID inside an upload's S3 key, which is `<instrument>/<run>/<file>`
 * (`request-upload-url/route.ts`). Null for a key that isn't that shape.
 */
export function runIdFromS3Key(s3Key: string | null): string | null {
  return s3Key ? (RUN_IN_S3_KEY.exec(s3Key)?.[1] ?? null) : null;
}

function runFact(runId: string | null): EventFact[] {
  return runId ? [{ kind: "run", runId }] : [];
}

/** The watcher's own message, or `fallback` when it sent none. */
function ownMessage(event: EventInput, fallback: string): MessagePart[] {
  return [t(event.message.trim() || fallback)];
}

/** "Watcher" or "Service": who the message says stopped or started. */
function roleOf(message: string): string {
  return /^(Watcher|Service)\b/.exec(message)?.[1] ?? "Watcher";
}

// ---------------------------------------------------------------------------
// One handler per event type
// ---------------------------------------------------------------------------

function describeStarted(event: EventInput): Described {
  const role = roleOf(event.message);
  const applied = /^\w+ restarted on (.+) with config revision (\d+)$/.exec(
    event.message
  );
  if (applied) {
    return {
      label: "Started",
      tone: "neutral",
      message: [
        t(
          `${role} restarted on ${applied[1]} to apply settings revision ${applied[2]}`
        ),
      ],
    };
  }
  const previous = /^\w+ restarted on (.+) with its previous config$/.exec(
    event.message
  );
  if (previous) {
    return {
      label: "Started",
      tone: "neutral",
      message: [
        t(`${role} restarted on ${previous[1]} with its previous settings`),
      ],
    };
  }
  return {
    label: "Started",
    tone: "neutral",
    message: ownMessage(event, "Started"),
  };
}

function describeStopped(event: EventInput, details: Details): Described {
  if (details.kind === UPLOAD_REQUESTS_CANCELLED_KIND) {
    return describeCancelled(details);
  }
  const role = roleOf(event.message);
  const reason = restartReasonOf(event);
  if (reason === "update") {
    return {
      label: "Stopped",
      tone: "muted",
      message: [t(`${role} stopped to install an update`)],
    };
  }
  if (reason === "windows") {
    return {
      label: "Stopped",
      tone: "muted",
      message: [
        t(`${role} stopped because Windows is restarting or shutting down`),
      ],
    };
  }
  if (/registration was deleted/i.test(event.message)) {
    return {
      label: "Stopped",
      tone: "muted",
      message: [t(`${role} stopped because it was deregistered on Data Hub`)],
    };
  }
  if (/stopped by user/i.test(event.message)) {
    return {
      label: "Stopped",
      tone: "muted",
      message: [t(`${role} stopped by someone on the PC`)],
    };
  }
  const from = text(details, "from");
  const to = text(details, "to");
  if (from && to && /^environment switched/i.test(event.message)) {
    return {
      label: "Stopped",
      tone: "muted",
      message: [t(`Switched from the ${from} environment to ${to}`)],
    };
  }
  return {
    label: "Stopped",
    tone: "muted",
    message: ownMessage(event, "Stopped"),
  };
}

function uploadFileName(event: EventInput, details: Details): string | null {
  const fromMessage = /^Uploaded (.+)$/.exec(event.message.trim())?.[1];
  if (fromMessage) {
    return fromMessage;
  }
  const s3Key = text(details, "s3_key");
  return s3Key ? baseName(s3Key) : null;
}

function describeUploaded(event: EventInput, details: Details): Described {
  const name = uploadFileName(event, details);
  const facts: EventFact[] = [];
  const size = whole(details, "size_bytes");
  if (size !== null) {
    facts.push({ kind: "value", label: "Size", value: formatBytes(size) });
  }
  facts.push(...runFact(runIdFromS3Key(text(details, "s3_key"))));
  const parts = whole(details, "part_count");
  if (parts !== null && parts > 0) {
    facts.push({
      kind: "note",
      text: parts === 1 ? "Uploaded in one part" : `Uploaded in ${parts} parts`,
    });
  }
  return {
    label: "File uploaded",
    tone: "success",
    message: name ? [t("Uploaded "), file(name)] : [t("Uploaded a file")],
    facts,
  };
}

function describeUploadFailed(event: EventInput, details: Details): Described {
  const message = event.message.trim();
  // A failed upload carries the file's S3 key, which holds its run, and the
  // error that stopped it.
  const runId =
    text(details, "run_id") ?? runIdFromS3Key(text(details, "s3_key"));
  const error = text(details, "error");
  const facts: EventFact[] = [
    ...runFact(runId),
    ...(error
      ? [{ kind: "value" as const, label: "Error", value: error }]
      : []),
  ];

  if (details.will_retry === true) {
    const name =
      text(details, "relative_path") ??
      /^Can't read (.+?) yet/.exec(message)?.[1] ??
      null;
    return {
      label: "File not ready",
      tone: "warning",
      message: name
        ? [file(name), t(" can't be read yet. The watcher will try again.")]
        : [t("A file can't be read yet. The watcher will try again.")],
      facts,
    };
  }

  const deleted = /^Upload refused: run (.+) was deleted/.exec(message);
  if (text(details, "reason") === "run_deleted" || deleted) {
    const deletedRun = runId ?? deleted?.[1] ?? null;
    return {
      label: "Upload failed",
      tone: "error",
      message: deletedRun
        ? [
            t("Upload refused: run "),
            run(deletedRun),
            t(" was deleted on Data Hub"),
          ]
        : [t("Upload refused: the run was deleted on Data Hub")],
      facts,
    };
  }

  const patterns: [RegExp, (name: string) => MessagePart[]][] = [
    [/^Upload failed: (.+)$/, (name) => [t("Couldn't upload "), file(name)]],
    [
      /^Presigned URL request failed: (.+)$/,
      (name) => [t("Couldn't start the upload of "), file(name)],
    ],
    [
      /^Hashing failed: (.+)$/,
      (name) => [t("Couldn't read "), file(name), t(" to prepare the upload")],
    ],
    [
      /^Upload notification failed: (.+)$/,
      (name) => [
        t("Uploaded "),
        file(name),
        t(", but couldn't tell Data Hub it arrived"),
      ],
    ],
  ];
  for (const [pattern, build] of patterns) {
    const name = pattern.exec(message)?.[1];
    if (name) {
      return {
        label: "Upload failed",
        tone: "error",
        message: build(name),
        facts,
      };
    }
  }
  return {
    label: "Upload failed",
    tone: "error",
    message: ownMessage(event, "Upload failed"),
    facts,
  };
}

function describeRunReported(event: EventInput, details: Details): Described {
  const runId =
    text(details, "run_id") ??
    /^Run (.+) reported$/.exec(event.message.trim())?.[1] ??
    null;
  return {
    label: "Run reported",
    tone: "info",
    message: runId
      ? [t("Run "), run(runId), t(" reported")]
      : ownMessage(event, "Run reported"),
  };
}

const SYNC_TRIGGERS: Record<string, string> = {
  startup: "when the watcher started",
  init: "when the watcher was set up",
  edit: "after the settings file was edited",
  open: "after the settings file was opened",
  "env-switch": "after the watcher switched environment",
  config_revision: "to apply a settings change",
};

function describeConfigSynced(event: EventInput, details: Details): Described {
  if (details.kind === UPLOAD_REQUESTS_CANCELLED_KIND) {
    return describeCancelled(details);
  }
  if (details.kind === "config_revision_applied") {
    const revision = whole(details, "revision");
    return {
      label: "Settings applied",
      tone: "info",
      message: [
        t(
          revision === null
            ? "Applied a settings change"
            : `Applied settings revision ${revision}`
        ),
      ],
    };
  }
  const trigger = text(details, "trigger");
  if (trigger) {
    const when = SYNC_TRIGGERS[trigger];
    return {
      label: "Settings synced",
      tone: "neutral",
      message: [
        t(`Sent the settings file to Data Hub${when ? ` ${when}` : ""}`),
      ],
    };
  }
  return {
    label: "Settings synced",
    tone: "neutral",
    message: ownMessage(event, "Settings synced"),
  };
}

function describeUpdateStarted(event: EventInput, details: Details): Described {
  const from = text(details, "current_version");
  const to = text(details, "target_version");
  return {
    label: "Update started",
    tone: "update",
    message:
      from && to
        ? [t(`Updating from ${from} to ${to}`)]
        : ownMessage(event, "Update started"),
  };
}

function describeUpdateSucceeded(
  event: EventInput,
  details: Details
): Described {
  const from = text(details, "previous_version");
  const to = text(details, "target_version");
  let message = ownMessage(event, "Update finished");
  if (to) {
    message = [
      t(`Restarted into version ${to}${from ? ` (was ${from})` : ""}`),
    ];
  }
  return { label: "Update finished", tone: "update", message };
}

function describeUpdateFailed(event: EventInput, details: Details): Described {
  const from =
    text(details, "current_version") ?? text(details, "previous_version");
  const to = text(details, "target_version");
  let message = ownMessage(event, "Update failed");
  if (to) {
    message = [
      t(`Couldn't update${from ? ` from ${from}` : ""} to version ${to}`),
    ];
  }
  return { label: "Update failed", tone: "error", message };
}

const CANCEL_CAUSES: Record<string, string> = {
  watcher_stopped: "the watcher stopped",
  watcher_deregistered: "the watcher was deregistered",
  instrument_retired: "the instrument was retired",
  watcher_offline_sweep: "the watcher stopped checking in",
};

/**
 * The server cancelled requested uploads. The row's type varies with the cause
 * (`upload_requests_cancelled`, `watcher_stopped`, `error`, `config_synced`), the
 * `details` say which.
 */
function describeCancelled(details: Details): Described {
  const count = whole(details, "cancelled_count");
  const uploads =
    count === null ? "requested uploads" : pluralize(count, "requested upload");
  const lead = `Cancelled ${uploads} because `;
  const reason = text(details, "reason");
  const runId = text(details, "run_id");
  const facts: EventFact[] = [];
  let message: MessagePart[];
  if (reason === "run_deleted" && runId) {
    message = [t(`${lead}run `), run(runId), t(" was deleted")];
  } else if (reason === "run_deleted") {
    message = [t(`${lead}the run was deleted`)];
  } else if (reason && CANCEL_CAUSES[reason]) {
    message = [t(lead + CANCEL_CAUSES[reason])];
  } else if (text(details, "watch_directory")) {
    message = [t(`${lead}the watch folder changed`)];
    const previous = text(details, "previous_watch_directory");
    const next = text(details, "watch_directory");
    if (previous) {
      facts.push({ kind: "value", label: "Was", value: previous });
    }
    if (next) {
      facts.push({ kind: "value", label: "Now", value: next });
    }
  } else {
    message = [t(`${lead}no watcher was online to upload them`)];
  }
  return { label: "Uploads cancelled", tone: "warning", message, facts };
}

// ---------------------------------------------------------------------------
// `error` events: the watcher says what went wrong in `details.kind`
// ---------------------------------------------------------------------------

type ErrorHandler = (event: EventInput, details: Details) => Described;

function inARow(failures: number | null): string {
  return failures !== null && failures > 1
    ? ` (${failures} times in a row)`
    : "";
}

const ERROR_KINDS: Record<string, ErrorHandler> = {
  heartbeat_recovered: (_event, details) => {
    const missed = whole(details, "consecutive_failures");
    const gap = whole(details, "gap_seconds");
    return {
      label: "Missed heartbeat",
      tone: "warning",
      message: [
        t(
          missed === null
            ? "Checked in again after missing a heartbeat"
            : `Checked in again after missing ${pluralize(missed, "heartbeat")}`
        ),
      ],
      facts:
        gap !== null && gap > 0
          ? [
              {
                kind: "value",
                label: "Out of contact for",
                value: describeDuration(gap),
              },
            ]
          : [],
    };
  },
  run_report_failed: (event, details) => {
    const runId = text(details, "run_id");
    const deleted = text(details, "reason") === "run_deleted";
    let message: MessagePart[];
    if (runId && deleted) {
      message = [
        t("Run "),
        run(runId),
        t(" was deleted on Data Hub, so its files aren't reported"),
      ];
    } else if (runId) {
      message = [t("Couldn't report run "), run(runId), t(" to Data Hub")];
    } else {
      message = ownMessage(event, "Couldn't report a run to Data Hub");
    }
    return {
      label: "Run report failed",
      tone: "error",
      message,
      facts: runFact(runId),
    };
  },
  state_write_failed: (_event, details) => {
    const runId = text(details, "run_id");
    return {
      label: "Couldn't save",
      tone: "error",
      message: runId
        ? [
            t("Couldn't save run "),
            run(runId),
            t(" on the PC. The watcher will try again."),
          ]
        : [t("Couldn't save a run on the PC. The watcher will try again.")],
      facts: runFact(runId),
    };
  },
  config_sync_failed: () => ({
    label: "Settings sync failed",
    tone: "error",
    message: [t("Couldn't send the settings file to Data Hub")],
  }),
  stability_timeout: (_event, details) => {
    const path = text(details, "path");
    const wait = whole(details, "max_wait_seconds");
    const lead = path
      ? [file(baseName(path)), t(" kept changing")]
      : [t("A file kept changing")];
    return {
      label: "File skipped",
      tone: "warning",
      message: [
        ...lead,
        t(
          `${wait === null ? "" : ` for over ${describeDuration(wait)}`}, so the watcher skipped it`
        ),
      ],
    };
  },
  stable_callback_failed: (_event, details) => {
    const path = text(details, "path");
    return {
      label: "File not processed",
      tone: "error",
      message: path
        ? [t("The watcher couldn't process "), file(baseName(path))]
        : [t("The watcher couldn't process a file")],
    };
  },
  pattern_mismatch: (_event, details) => {
    const path = text(details, "relative_path");
    return {
      label: "File skipped",
      tone: "warning",
      message: [
        ...(path ? [file(path)] : [t("A file")]),
        t(" doesn't match the run pattern, so the watcher skipped it"),
      ],
    };
  },
  events_dropped: (_event, details) => {
    const dropped = whole(details, "dropped_count");
    return {
      label: "Events lost",
      tone: "warning",
      message: [
        t(
          dropped === null
            ? "Some watcher events didn't reach Data Hub"
            : `${pluralize(dropped, "watcher event")} didn't reach Data Hub`
        ),
      ],
    };
  },
  upload_queue_poll_failed: (_event, details) => ({
    label: "Upload check failed",
    tone: "error",
    message: [
      t(
        `Couldn't ask Data Hub for requested uploads${inARow(whole(details, "consecutive_failures"))}`
      ),
    ],
  }),
  update_check_failed: (_event, details) => ({
    label: "Update check failed",
    tone: "error",
    message: [
      t(
        `Couldn't check for a new watcher version${inARow(whole(details, "consecutive_failures"))}`
      ),
    ],
  }),
  queued_file_missing: (event, details) => {
    const expected = text(details, "expected_path");
    const name =
      /^Queued file missing: (.+)$/.exec(event.message.trim())?.[1] ??
      (expected ? baseName(expected) : null);
    return {
      label: "File missing",
      tone: "error",
      message: name
        ? [t("Can't find "), file(name), t(" on the PC to upload it")]
        : [t("Can't find a requested file on the PC")],
    };
  },
  upload_request_cancelled: (_event, details) => {
    const attempts = whole(details, "attempts");
    return {
      label: "Upload request dropped",
      tone: "warning",
      message: [
        t(
          attempts === null
            ? "The watcher gave up on a requested upload"
            : `The watcher gave up on a requested upload after ${pluralize(attempts, "try", "tries")}`
        ),
      ],
    };
  },
  upload_retries_exhausted: (_event, details) => {
    const path = text(details, "relative_path");
    const runId = text(details, "run_id");
    return {
      label: "Upload gave up",
      tone: "error",
      message: [
        t("Stopped trying to upload "),
        ...(path ? [file(path)] : [t("a file")]),
      ],
      facts: runFact(runId),
    };
  },
  pending_upload_missing: (_event, details) => {
    const path = text(details, "relative_path");
    const runId = text(details, "run_id");
    return {
      label: "File missing",
      tone: "warning",
      message: [
        ...(path ? [file(path)] : [t("A file")]),
        t(" was waiting to upload, but it is no longer on the PC"),
      ],
      facts: runFact(runId),
    };
  },
  watch_directory_unavailable: (_event, details) => {
    const folder = text(details, "watch_directory");
    return {
      label: "Folder not found",
      tone: "warning",
      message: [
        ...(folder
          ? [t("The watch folder "), file(folder), t(" isn't available")]
          : [t("The watch folder isn't available")]),
        t(". The watcher is waiting for it."),
      ],
    };
  },
  unsafe_upload_path: () => ({
    label: "Upload refused",
    tone: "error",
    message: [
      t("Refused to upload a file whose path leads outside the watch folder"),
    ],
  }),
  config_revision_rejected: (_event, details) => {
    const revision = whole(details, "revision");
    const reason = text(details, "reason");
    const lead =
      revision === null
        ? "The watcher rejected a settings change"
        : `The watcher rejected settings revision ${revision}`;
    return {
      label: "Settings rejected",
      tone: "error",
      message: [t(reason ? `${lead}. ${reason}` : lead)],
    };
  },
  [UPLOAD_REQUESTS_CANCELLED_KIND]: (_event, details) =>
    describeCancelled(details),
};

function describeError(event: EventInput, details: Details): Described {
  const kind = text(details, "kind");
  const handler = kind ? ERROR_KINDS[kind] : undefined;
  if (handler) {
    return handler(event, details);
  }
  // A kind the code doesn't know yet, or no kind at all: the watcher's own
  // words, and a sentence-case name when it sent none.
  return {
    label: "Error",
    tone: "error",
    message: ownMessage(event, kind ? sentenceCase(kind) : "Error"),
  };
}

// ---------------------------------------------------------------------------
// The public function
// ---------------------------------------------------------------------------

function describeByType(event: EventInput, details: Details): Described {
  switch (event.eventType) {
    case "watcher_started":
      return describeStarted(event);
    case "watcher_stopped":
      return describeStopped(event, details);
    case "file_uploaded":
      return describeUploaded(event, details);
    case "upload_failed":
      return describeUploadFailed(event, details);
    case "run_reported":
      return describeRunReported(event, details);
    case "config_synced":
      return describeConfigSynced(event, details);
    case "error":
      return describeError(event, details);
    case "update_started":
      return describeUpdateStarted(event, details);
    case "update_succeeded":
      return describeUpdateSucceeded(event, details);
    case "update_failed":
      return describeUpdateFailed(event, details);
    case "upload_requests_cancelled":
      return describeCancelled(details);
    default: {
      // A type added to the enum after this was written: a label from its name
      // and the watcher's message, never the raw type.
      const label = sentenceCase(event.eventType);
      return { label, tone: "neutral", message: ownMessage(event, label) };
    }
  }
}

/**
 * A label, a tone for the label pill, a plain message and the details to show
 * when the row is open, for one watcher event.
 */
export function describeEvent(event: EventInput): EventDescription {
  const described = describeByType(event, asDetails(event.details));
  return {
    label: described.label,
    tone: described.tone,
    message: described.message,
    text: partsToText(described.message),
    facts: described.facts ?? [],
  };
}
