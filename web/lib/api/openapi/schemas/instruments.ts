import { z } from "zod";
import {
  instrumentStatusSchema,
  instrumentTypeSchema,
  isoDateTime,
} from "./common";

export const createInstrumentBody = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Must be lowercase kebab-case"),
  display_name: z.string().min(1).optional(),
  instrument_type: instrumentTypeSchema.optional(),
});

export const patchInstrumentBody = z.object({
  status: instrumentStatusSchema.optional(),
  display_name: z.string().min(1).optional(),
  instrument_type: instrumentTypeSchema.optional(),
});

export const instrumentListItem = z
  .object({
    id: z.string(),
    display_name: z.string(),
    status: instrumentStatusSchema,
    instrument_type: instrumentTypeSchema,
  })
  .openapi("InstrumentListItem");

export const instrumentDetail = instrumentListItem
  .extend({
    created_at: isoDateTime,
    updated_at: isoDateTime.optional(),
    run_count: z.number().int().optional(),
    watcher_count: z.number().int().optional(),
  })
  .openapi("InstrumentDetail");
