import type { McpServer } from "@modelcontextprotocol/server";
import {
  createFeedback,
  getFeedbackForViewer,
  listFeedback,
  presentFeedback,
  previewFeedbackDescription,
} from "@/lib/api/feedback";
import {
  FEEDBACK_PAGE_SIZE,
  feedbackContentSchema,
} from "@/lib/api/feedback-schema";
import { userIsAdmin } from "@/lib/api/user-admin";
import { toolRegistrationConfig } from "@/lib/mcp/catalog/register";
import {
  errorResult,
  getMcpUserId,
  structuredResult,
} from "@/lib/mcp/tools/helpers";
import {
  getFeedbackTool,
  listFeedbackTool,
  sendFeedbackTool,
} from "./feedback.defs";

export function registerFeedbackTools(server: McpServer) {
  server.registerTool(
    sendFeedbackTool.name,
    toolRegistrationConfig(sendFeedbackTool),
    async (args, ctx) => {
      const userId = getMcpUserId(ctx.http?.authInfo);
      if (!userId) {
        return errorResult("Authenticated user not available on this session.");
      }
      const parsed = feedbackContentSchema.safeParse(args);
      if (!parsed.success) {
        return errorResult(
          parsed.error.issues[0]?.message ?? "Invalid feedback."
        );
      }
      const result = await createFeedback({
        ...parsed.data,
        userId,
        source: "mcp",
        oauthClientId: ctx.http?.authInfo?.clientId ?? null,
      });
      if (!result.ok) {
        return errorResult(result.message);
      }
      return structuredResult({
        duplicate: result.duplicate,
        feedback: presentFeedback(result.item, await userIsAdmin(userId)),
      });
    }
  );

  server.registerTool(
    listFeedbackTool.name,
    toolRegistrationConfig(listFeedbackTool),
    async (args, ctx) => {
      const userId = getMcpUserId(ctx.http?.authInfo);
      if (!userId) {
        return errorResult("Authenticated user not available on this session.");
      }
      const isAdmin = await userIsAdmin(userId);
      const limit = args.limit ?? FEEDBACK_PAGE_SIZE;
      const page = args.page ?? 1;
      const result = await listFeedback({
        viewerId: userId,
        isAdmin,
        status: args.status,
        kind: args.kind,
        limit,
        offset: (page - 1) * limit,
      });
      if (!result.ok) {
        return errorResult(result.message);
      }
      return structuredResult({
        feedback: result.items.map((item) => ({
          ...item,
          description: previewFeedbackDescription(item.description),
        })),
        total: result.total,
        counts: result.counts,
        groups: result.groups,
      });
    }
  );

  server.registerTool(
    getFeedbackTool.name,
    toolRegistrationConfig(getFeedbackTool),
    async (args, ctx) => {
      const userId = getMcpUserId(ctx.http?.authInfo);
      if (!userId) {
        return errorResult("Authenticated user not available on this session.");
      }
      const result = await getFeedbackForViewer(args.id, {
        viewerId: userId,
        isAdmin: await userIsAdmin(userId),
      });
      if (!result.ok) {
        return errorResult(result.message);
      }
      if (!result.item) {
        return errorResult(`Feedback '${args.id}' not found.`);
      }
      return structuredResult({ feedback: result.item });
    }
  );
}
