import { z } from "zod";
import type { McpToolDef } from "@/lib/mcp/catalog/types";
import { runReportToolUiMeta } from "@/lib/mcp/ui-apps";
import {
  REPORT_ITEMS_MAX_LIMIT,
  REPORT_ITEMS_WINDOW,
} from "@/lib/runs/report-items";
import {
  reportViewFileUrlOutputSchema,
  reportViewItemKindSchema,
  reportViewItemsOutputSchema,
} from "./report-views.output";

const APP_ONLY_META = runReportToolUiMeta(["app"]);

export const reportViewItemsTool = {
  name: "report_view_items",
  group: "runs",
  scope: "files:read",
  title: "Report View Items",
  description:
    "Return a paginated window of run report items (images, PDFs, spectra, or videos) with download URLs. Used by the Data Hub run report view. Call `get_run_report` instead.",
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

export const reportViewFileUrlTool = {
  name: "report_view_file_url",
  group: "runs",
  scope: "files:read",
  title: "Report View File URL",
  description:
    "Return a short-lived download URL for one file on a run, found by numeric id or by filename suffix. The view reads CSV and JSON bodies from that URL itself. Used by the Data Hub run report view. Call `get_run_report` instead.",
  outputSchema: reportViewFileUrlOutputSchema,
  inputSchema: {
    instrumentId: z.string().describe("Instrument identifier"),
    runId: z.string().describe("Run identifier within the instrument"),
    fileId: z
      .number()
      .int()
      .optional()
      .describe("Numeric file ID. Takes precedence over `suffix`"),
    suffix: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Filename suffix to match instead of an id, e.g. _aunty_plate.json"
      ),
  },
  annotations: { readOnlyHint: true },
  _meta: APP_ONLY_META,
} as const satisfies McpToolDef;

export const REPORT_VIEW_TOOL_DEFS = [
  reportViewItemsTool,
  reportViewFileUrlTool,
] as const;
