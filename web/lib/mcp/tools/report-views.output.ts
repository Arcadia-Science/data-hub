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

export const reportViewFileUrlOutputSchema = z.object({
  id: z.number().int(),
  filename: z.string(),
  url: z.string(),
});

export const reportViewItemKindSchema = z.enum(REPORT_ITEM_KINDS);
