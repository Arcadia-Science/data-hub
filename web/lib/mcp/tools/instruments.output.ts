import { z } from "zod";
import {
  instrumentStatusSchema,
  instrumentTypeSchema,
  isoDateTime,
} from "@/lib/api/openapi/schemas/common";
import { mcpActorUserSchema } from "./common.output";

/** List-row shape from `getInstrumentListWithCounts` after JSON round-trip. */
export const instrumentListItemSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  status: instrumentStatusSchema,
  instrumentType: instrumentTypeSchema,
  filePatterns: z.array(z.string()),
  hasDeregisteredWatcher: z.boolean(),
  runCount: z.number().int(),
  runsThisWeek: z.number().int(),
  lastRunAt: isoDateTime.nullable(),
  lastWatcherHeartbeatAt: isoDateTime.nullable(),
  watcherCount: z.number().int(),
  watchersOnline: z.number().int(),
  createdAt: isoDateTime,
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
  filePatterns: z.array(z.string()),
  runCount: z.number().int(),
  watcherCount: z.number().int(),
  watchersOnline: z.number().int(),
  watchersOffline: z.number().int(),
  lastWatcherHeartbeatAt: isoDateTime.nullable(),
  activeWatcherId: z.string().nullable(),
  activeWatcherHostname: z.string().nullable(),
  activeWatcherDeregistered: z.boolean(),
  retiredAt: isoDateTime.nullable(),
  retiredByUser: mcpActorUserSchema.nullable(),
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
