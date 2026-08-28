import { z } from "zod";
import type { McpToolDef } from "@/lib/mcp/catalog/types";
import {
  REPORT_VIEW_TABLE_DEFAULT_LIMIT,
  REPORT_VIEW_TABLE_MAX_LIMIT,
  RUN_REPORT_UI_RESOURCE_URI,
} from "@/lib/mcp/ui-apps";
import {
  REPORT_ITEMS_MAX_LIMIT,
  REPORT_ITEMS_WINDOW,
} from "@/lib/runs/report-items";
import {
  reportViewArtifactOutputSchema,
  reportViewItemKindSchema,
  reportViewItemsOutputSchema,
  reportViewTableOutputSchema,
} from "./report-views.output";

const APP_ONLY_META = {
  ui: {
    resourceUri: RUN_REPORT_UI_RESOURCE_URI,
    visibility: ["app"] as const,
  },
};

const INTERNAL_STEER =
  "Internal. Used by the Data Hub run report view. Call `get_run_report` instead.";

export const reportViewItemsTool = {
  name: "report_view_items",
  group: "runs",
  scope: "files:read",
  title: "Report View Items",
  description: INTERNAL_STEER,
  outputSchema: reportViewItemsOutputSchema,
  inputSchema: {
    instrumentId: z.string().describe("Instrument identifier"),
    runId: z.string().describe("Run identifier within the instrument"),
    kind: reportViewItemKindSchema.describe(
      "Report item kind: image, pdf, spectrum, or video"
    ),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Window start index (default: 0)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(REPORT_ITEMS_MAX_LIMIT)
      .optional()
      .describe(
        `Items per window (default: ${REPORT_ITEMS_WINDOW}, max: ${REPORT_ITEMS_MAX_LIMIT})`
      ),
    search: z.string().optional().describe("Filename substring filter"),
    anchor: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("File id to centre the window on; overrides offset when found"),
  },
  annotations: { readOnlyHint: true },
  _meta: APP_ONLY_META,
} as const satisfies McpToolDef;

export const reportViewTableTool = {
  name: "report_view_table",
  group: "runs",
  scope: "files:read",
  title: "Report View Table",
  description: INTERNAL_STEER,
  outputSchema: reportViewTableOutputSchema,
  inputSchema: {
    instrumentId: z.string().describe("Instrument identifier"),
    runId: z.string().describe("Run identifier within the instrument"),
    fileId: z.number().int().describe("Numeric file ID of the CSV"),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Row offset (default: 0)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(REPORT_VIEW_TABLE_MAX_LIMIT)
      .optional()
      .describe(
        `Rows to return (default: ${REPORT_VIEW_TABLE_DEFAULT_LIMIT}, max: ${REPORT_VIEW_TABLE_MAX_LIMIT})`
      ),
  },
  annotations: { readOnlyHint: true },
  _meta: APP_ONLY_META,
} as const satisfies McpToolDef;

export const reportViewArtifactTool = {
  name: "report_view_artifact",
  group: "runs",
  scope: "files:read",
  title: "Report View Artifact",
  description: INTERNAL_STEER,
  outputSchema: reportViewArtifactOutputSchema,
  inputSchema: {
    instrumentId: z.string().describe("Instrument identifier"),
    runId: z.string().describe("Run identifier within the instrument"),
    suffix: z
      .string()
      .min(1)
      .describe("Filename suffix of the JSON artifact, e.g. _aunty_plate.json"),
  },
  annotations: { readOnlyHint: true },
  _meta: APP_ONLY_META,
} as const satisfies McpToolDef;

export const REPORT_VIEW_TOOL_DEFS = [
  reportViewItemsTool,
  reportViewTableTool,
  reportViewArtifactTool,
] as const;
