import { z } from "zod";
import {
  CONNECTION_REASONS,
  CONNECTION_STATES,
  WATCHER_CONFIG_STATES,
} from "@/lib/instruments/connection";
import {
  instrumentStatusSchema,
  instrumentTypeSchema,
  isoDateTime,
  uploadModeSchema,
  watcherStatusSchema,
} from "./common";

export const createInstrumentBody = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Must be lowercase kebab-case"),
  // Trim so whitespace-only values fall through to the id-derived default.
  display_name: z.string().trim().optional(),
  instrument_type: instrumentTypeSchema.optional(),
});

export const patchInstrumentBody = z.object({
  status: instrumentStatusSchema.optional(),
  display_name: z.string().trim().min(1).optional(),
  instrument_type: instrumentTypeSchema.optional(),
});

/** The instrument as `POST` and `PATCH /instruments` return it. */
export const instrumentRecord = z
  .object({
    id: z.string(),
    display_name: z.string(),
    status: instrumentStatusSchema,
    instrument_type: instrumentTypeSchema,
    created_at: isoDateTime,
    updated_at: isoDateTime.optional(),
  })
  .openapi("InstrumentRecord");

export const instrumentWatcher = z
  .object({
    id: z.string(),
    hostname: z.string().nullable(),
    os_info: z.string().nullable(),
    version: z
      .string()
      .nullable()
      .describe("Installed watcher version. Null until its first heartbeat."),
    status: watcherStatusSchema.describe(
      "Detailed watcher status. `stale` means no heartbeat for 5 minutes, or no return from a restart within 15."
    ),
    status_reason: z
      .string()
      .nullable()
      .describe(
        "Why the watcher is waiting (the missing folder), or why it stopped for a restart (`system_shutdown` or `auto_update`). The reason stays while the status reads `stale`."
      ),
    last_heartbeat_at: isoDateTime.nullable(),
    watch_directory: z.string().nullable(),
    file_patterns: z
      .array(z.string())
      .describe("File patterns from the watcher's config, in config order."),
    upload_mode: uploadModeSchema,
    config_state: z
      .enum(WATCHER_CONFIG_STATES)
      .describe(
        "State of the watcher's settings: `pending` (a change is waiting for the watcher), `rejected` (the watcher refused the latest change), `edited_on_pc` (a PC edit takes effect when the watcher restarts), `applied`, or `none`."
      ),
    shared_computer_with: z
      .array(z.object({ instrument_id: z.string(), display_name: z.string() }))
      .describe(
        "Other instruments whose active watchers run on the same computer (hostnames compared without case)."
      ),
  })
  .openapi("InstrumentWatcher", {
    description:
      "An instrument's one active watcher: the program on the instrument PC that finds new files and uploads them.",
  });

export const instrumentConnection = z
  .object({
    state: z
      .enum(CONNECTION_STATES)
      .describe(
        "`online`: the watcher checked in within 5 minutes. `restarting`: the watcher stopped for a Windows restart or an automatic update less than 15 minutes ago. `connecting`: the watcher registered and hasn't sent a heartbeat yet. `offline`: anything else. The instrument's own status plays no part: a pending instrument can be `online`."
      ),
    reason: z
      .enum(CONNECTION_REASONS)
      .nullable()
      .describe("Why the instrument is offline. Null in every other state."),
  })
  .openapi("InstrumentConnection", {
    description: "Whether new files can reach Data Hub, and why not.",
  });

export const instrumentListItem = z
  .object({
    id: z.string(),
    display_name: z.string(),
    status: instrumentStatusSchema,
    instrument_type: instrumentTypeSchema,
    // Null when the instrument has no active watcher. A union with null,
    // not `.nullable()`, so the `InstrumentWatcher` component itself stays an
    // object.
    watcher: z.union([instrumentWatcher, z.null()]),
    connection: instrumentConnection,
    past_watcher_count: z
      .number()
      .int()
      .describe("How many deregistered watchers the instrument has had."),
  })
  .openapi("InstrumentListItem");

export const instrumentDetail = instrumentListItem
  .extend({
    created_at: isoDateTime,
    updated_at: isoDateTime.optional(),
    run_count: z.number().int().optional(),
    watcher_count: z.number().int().optional().openapi({
      deprecated: true,
      description:
        "Deprecated. An instrument has at most one watcher: use `watcher`, which is null when it has none.",
    }),
  })
  .openapi("InstrumentDetail");
