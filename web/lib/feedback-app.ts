// What Data Hub says about itself to the feedback package. Kept apart from
// `lib/feedback.ts` because the MCP catalog reads it without a database.

export const FEEDBACK_APP = {
  appName: "Data Hub",
  mcpAppScope: "the web app, MCP tools, or the watcher",
  mcpGuidance:
    "For a problem with a specific run's data, use add_run_comment instead.",
} as const;

// The package's MCP functions name these fields differently from its server
// config, so the tool catalog and the instructions share this mapping.
export const FEEDBACK_MCP_OPTIONS = {
  appName: FEEDBACK_APP.appName,
  appScope: FEEDBACK_APP.mcpAppScope,
  guidance: FEEDBACK_APP.mcpGuidance,
} as const;
