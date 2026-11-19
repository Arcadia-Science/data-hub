import { z } from "zod";
import {
  instrumentStatusSchema,
  instrumentTypeSchema,
  isoDateTime,
} from "@/lib/api/openapi/schemas/common";
import { EFFECTIVE_STATUSES } from "@/lib/api/watcher-status";
import {
  CONNECTION_REASONS,
  CONNECTION_STATES,
  UPLOAD_MODES,
  WATCHER_CONFIG_STATES,
} from "@/lib/instruments/connection";
import { mcpActorTokenSchema, mcpActorUserSchema } from "./common.output";

// Marks a field as deprecated in the tool's output schema. The JSON Schema
// gets `deprecated: true`, and the description starts with "Deprecated." so
// that it shows wherever a client or the docs site lists the field.
export const deprecated = (replacement: string) => ({
  deprecated: true,
  description: `Deprecated. ${replacement}`,
});

/** One instrument's active watcher, from `getInstrumentWatcherInfo`. */
export const instrumentWatcherSchema = z
  .object({
    id: z.string(),
    hostname: z.string().nullable(),
    osInfo: z.string().nullable(),
    version: z
      .string()
      .nullable()
      .describe("Installed watcher version. Null until its first heartbeat."),
    status: z
      .enum(EFFECTIVE_STATUSES)
      .describe(
        "Detailed watcher status. `stale` means no heartbeat for 5 minutes, or no return from a restart within 15."
      ),
    statusReason: z
      .string()
      .nullable()
      .describe(
        "Why the watcher is waiting (the missing folder), or why it stopped for a restart (`system_shutdown` or `auto_update`). The reason stays while the status reads `stale`."
      ),
    lastHeartbeatAt: isoDateTime.nullable(),
    watchDirectory: z.string().nullable(),
    filePatterns: z
      .array(z.string())
      .describe("File patterns from the watcher's config, in config order."),
    uploadMode: z.enum(UPLOAD_MODES),
    configState: z
      .enum(WATCHER_CONFIG_STATES)
      .describe(
        "State of the watcher's settings: `pending` (a change is waiting for the watcher), `rejected` (the watcher refused the latest change), `edited_on_pc` (a PC edit takes effect when the watcher restarts), `applied`, or `none`."
      ),
    sharedComputerWith: z
      .array(z.object({ instrumentId: z.string(), displayName: z.string() }))
      .describe(
        "Other instruments whose active watchers run on the same computer (hostnames compared without case)."
      ),
  })
  .nullable()
  .describe(
    "The instrument's one active watcher, or null when it has none. Replaces watcherCount, watchersOnline and the activeWatcher* fields."
  );

export const instrumentConnectionSchema = z
  .object({
    state: z.enum(CONNECTION_STATES),
    reason: z
      .enum(CONNECTION_REASONS)
      .nullable()
      .describe("Why the instrument is offline. Null in every other state."),
  })
  .describe(
    "Whether new files can reach Data Hub. `online`: the watcher checked in within 5 minutes. `restarting`: the watcher stopped for a Windows restart or an automatic update less than 15 minutes ago. `connecting`: the watcher registered and hasn't sent a heartbeat yet, for up to 15 minutes after it registered or the instrument was confirmed; after that the instrument is `offline` with reason `never_checked_in`. `offline`: anything else. This does not take the instrument's status into account: a pending instrument can be `online`."
  );

const pastWatcherCountSchema = z
  .number()
  .int()
  .describe("How many deregistered watchers the instrument has had.");

/** List-row shape from `getInstrumentListWithCounts` after JSON round-trip. */
export const instrumentListItemSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  status: instrumentStatusSchema,
  instrumentType: instrumentTypeSchema,
  watcher: instrumentWatcherSchema,
  connection: instrumentConnectionSchema,
  pastWatcherCount: pastWatcherCountSchema,
  filePatterns: z
    .array(z.string())
    .meta(
      deprecated(
        "Use `watcher.filePatterns`, which keeps the config's order. This list is de-duplicated and sorted."
      )
    ),
  runCount: z.number().int(),
  runsThisWeek: z.number().int(),
  lastRunAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  activeWatcherId: z
    .string()
    .nullable()
    .meta(
      deprecated(
        "Use `watcher.id`. This also names the most recently deregistered watcher when none is active."
      )
    ),
  hasDeregisteredWatcher: z
    .boolean()
    .meta(deprecated("Use `pastWatcherCount > 0`, or `connection.reason`.")),
  lastWatcherHeartbeatAt: isoDateTime
    .nullable()
    .meta(deprecated("Use `watcher.lastHeartbeatAt`.")),
  watcherCount: z
    .number()
    .int()
    .meta(deprecated("An instrument has at most one watcher. Use `watcher`.")),
  watchersOnline: z
    .number()
    .int()
    .meta(deprecated('Use `connection.state === "online"`.')),
});

// Object root so 2025-era MCP clients don't SEP-2106-wrap a bare array as
// `{ result: [...] }` while text content stays unwrapped.
export const listInstrumentsOutputSchema = z.object({
  instruments: z.array(instrumentListItemSchema),
});

/** Detail shape from `getInstrumentById` after JSON round-trip. */
export const getInstrumentOutputSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  status: instrumentStatusSchema,
  instrumentType: instrumentTypeSchema,
  watcher: instrumentWatcherSchema,
  connection: instrumentConnectionSchema,
  pastWatcherCount: pastWatcherCountSchema,
  filePatterns: z
    .array(z.string())
    .meta(
      deprecated(
        "Use `watcher.filePatterns`, which keeps the config's order. This list is de-duplicated and sorted."
      )
    ),
  runCount: z.number().int(),
  watcherCount: z
    .number()
    .int()
    .meta(deprecated("An instrument has at most one watcher. Use `watcher`.")),
  watchersOnline: z
    .number()
    .int()
    .meta(deprecated('Use `connection.state === "online"`.')),
  watchersOffline: z.number().int().meta(deprecated("Use `connection.state`.")),
  lastWatcherHeartbeatAt: isoDateTime
    .nullable()
    .meta(deprecated("Use `watcher.lastHeartbeatAt`.")),
  activeWatcherId: z
    .string()
    .nullable()
    .meta(
      deprecated(
        "Use `watcher.id`. This also names the most recently deregistered watcher when none is active."
      )
    ),
  activeWatcherHostname: z
    .string()
    .nullable()
    .meta(deprecated("Use `watcher.hostname`.")),
  activeWatcherWatchDirectory: z
    .string()
    .nullable()
    .meta(deprecated("Use `watcher.watchDirectory`.")),
  activeWatcherDeregistered: z
    .boolean()
    .meta(deprecated('Use `connection.reason === "deregistered"`.')),
  retiredAt: isoDateTime.nullable(),
  retiredByUser: mcpActorUserSchema.nullable(),
  retiredByToken: mcpActorTokenSchema.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});

/**
 * `options` varies by instrument type (plate reader, gel doc, qPCR, …).
 * Keep it open so new filter keys don't break the tool contract.
 */
export const getInstrumentFilterOptionsOutputSchema = z.object({
  instrumentId: z.string(),
  options: z.record(z.string(), z.unknown()),
});
