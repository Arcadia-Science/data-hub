import { z } from "zod";
import {
  isoDateTime,
  uploadModeSchema,
  watcherEventTypeSchema,
  watcherStatusSchema,
} from "@/lib/api/openapi/schemas/common";

const actorUserSchema = z.object({
  userId: z.string(),
  displayName: z.string(),
  initials: z.string(),
  avatarUrl: z.string().nullable(),
});

/** List-row shape from `getWatcherList` after JSON round-trip. */
export const watcherListItemSchema = z.object({
  id: z.string(),
  instrumentId: z.string(),
  instrumentDisplayName: z.string().nullable(),
  hostname: z.string().nullable(),
  watcherVersion: z.string().nullable(),
  effectiveStatus: watcherStatusSchema,
  lastHeartbeatAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  deletedAt: isoDateTime.nullable(),
});

// Object root so 2025-era MCP clients don't SEP-2106-wrap a bare array as
// `{ result: [...] }` while text content stays unwrapped.
export const listWatchersOutputSchema = z.object({
  watchers: z.array(watcherListItemSchema),
});

export const getWatcherOutputSchema = watcherListItemSchema.extend({
  osInfo: z.string().nullable(),
  configYaml: z.string().nullable(),
  configChecksum: z.string().nullable(),
  updatedAt: isoDateTime,
  deregisteredByUser: actorUserSchema.nullable(),
});

const watcherEventRowSchema = z.object({
  id: z.number().int(),
  eventType: watcherEventTypeSchema,
  message: z.string(),
  details: z.unknown(),
  timestamp: isoDateTime,
});

export const listWatcherEventsOutputSchema = z.object({
  watcherId: z.string(),
  sinceIso: isoDateTime,
  lookbackHours: z.number().int(),
  rows: z.array(watcherEventRowSchema),
  total: z.number().int(),
});

const watcherHeartbeatRowSchema = z.object({
  id: z.number().int(),
  timestamp: isoDateTime,
  status: z.string(),
  uploadMode: uploadModeSchema.nullable(),
  filesUploadedSinceLast: z.number().int().nullable(),
  runsReportedSinceLast: z.number().int().nullable(),
  errorsSinceLast: z.number().int().nullable(),
  uptimeSeconds: z.number().int().nullable(),
});

export const getWatcherHeartbeatsOutputSchema = z.object({
  watcherId: z.string(),
  sinceIso: isoDateTime,
  lookbackHours: z.number().int(),
  total: z.number().int(),
  heartbeats: z.array(watcherHeartbeatRowSchema),
});
