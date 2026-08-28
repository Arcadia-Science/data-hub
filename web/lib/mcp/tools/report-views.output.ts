import { z } from "zod";
import { REPORT_ITEM_KINDS } from "@/lib/runs/report-items";

export const reportViewItemSchema = z.object({
  id: z.number().int(),
  filename: z.string(),
  downloadUrl: z.string(),
});

export const reportViewItemsOutputSchema = z.object({
  data: z.array(reportViewItemSchema),
  pagination: z.object({
    anchor_index: z.number().int().nullable().optional(),
    limit: z.number().int(),
    offset: z.number().int(),
    total: z.number().int(),
  }),
});

export const reportViewTableOutputSchema = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), z.string())),
  total: z.number().int(),
});

export const reportViewArtifactOutputSchema = z.object({
  suffix: z.string(),
  filename: z.string(),
  artifact: z.unknown(),
});

export const reportViewItemKindSchema = z.enum(REPORT_ITEM_KINDS);
