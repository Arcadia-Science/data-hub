import { z } from "zod";
import {
  instrumentStatusSchema,
  isoDateTime,
} from "@/lib/api/openapi/schemas/common";

/** Success shape for `get_me` — matches `AuthenticatedUser` from `getUserById`. */
export const getMeOutputSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  image: z.string().nullable(),
  isAdmin: z.boolean(),
});

const searchRunResultSchema = z.object({
  type: z.literal("run"),
  id: z.string(),
  runId: z.string(),
  instrumentId: z.string(),
  instrumentName: z.string(),
  acquiredAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  fileCount: z.number().int(),
  totalSizeBytes: z.number(),
  matchReason: z.enum(["run_id", "file", "instrument", "ran_by"]),
  matchedFilename: z.string().nullable(),
});

const searchFileResultSchema = z.object({
  type: z.literal("file"),
  id: z.number().int(),
  filename: z.string(),
  instrumentId: z.string(),
  instrumentName: z.string(),
  runId: z.string(),
  sizeBytes: z.number().nullable(),
});

const searchInstrumentResultSchema = z.object({
  type: z.literal("instrument"),
  id: z.string(),
  displayName: z.string(),
  status: instrumentStatusSchema,
  watcherStatus: z.enum(["online", "offline", "no_watcher", "deregistered"]),
  lastWatcherHeartbeatAt: isoDateTime.nullable(),
  runCount: z.number().int(),
  matchReason: z.enum(["name", "pattern"]),
  matchedPattern: z.string().nullable(),
});

const searchUserResultSchema = z.object({
  type: z.literal("user"),
  id: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  image: z.string().nullable(),
});

const searchCommentResultSchema = z.object({
  type: z.literal("comment"),
  id: z.string(),
  bodyPreview: z.string(),
  createdAt: isoDateTime,
  instrumentId: z.string(),
  instrumentName: z.string(),
  runId: z.string(),
  userId: z.string(),
  userName: z.string(),
});

/** Grouped result from `globalSearch` (dates already ISO strings). */
export const globalSearchOutputSchema = z.object({
  runs: z.array(searchRunResultSchema),
  files: z.array(searchFileResultSchema),
  instruments: z.array(searchInstrumentResultSchema),
  users: z.array(searchUserResultSchema),
  comments: z.array(searchCommentResultSchema),
  counts: z.object({
    runs: z.number().int(),
    files: z.number().int(),
    instruments: z.number().int(),
    users: z.number().int(),
    comments: z.number().int(),
    total: z.number().int(),
  }),
});

/** Per-instrument row from `getInstrumentSummaries` after JSON round-trip. */
export const instrumentSummarySchema = z.object({
  id: z.string(),
  displayName: z.string(),
  status: instrumentStatusSchema,
  runCount: z.number().int(),
  lastRunAt: isoDateTime.nullable(),
  filesPendingUpload: z.number().int(),
  watcherStatus: z.enum(["online", "offline", "no_watcher"]),
});

// Object root so 2025-era MCP clients don't SEP-2106-wrap a bare array as
// `{ result: [...] }` while text content stays unwrapped.
export const getSystemStatusOutputSchema = z.object({
  instruments: z.array(instrumentSummarySchema),
});
