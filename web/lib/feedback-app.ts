// What Data Hub says about itself to the feedback package. Kept apart from
// `lib/feedback.ts` because the MCP catalog reads it without a database.

export const FEEDBACK_APP = {
  appName: "Data Hub",
  mcpAppScope: "the web app, MCP tools, or the watcher",
  mcpGuidance:
    "For a problem with a specific run's data, use add_run_comment instead.",
} as const;
