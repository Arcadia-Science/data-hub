import type { McpServer } from "@modelcontextprotocol/server";
import {
  createFeedback,
  FeedbackServiceError,
  getFeedbackForViewer,
  listFeedback,
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
      try {
        const result = await createFeedback({
          ...parsed.data,
          userId,
          source: "mcp",
          oauthClientId: ctx.http?.authInfo?.clientId ?? null,
        });
        return structuredResult({
          duplicate: result.duplicate,
          feedback: result.item,
        });
      } catch (err) {
        if (err instanceof FeedbackServiceError) {
          return errorResult(err.message);
        }
        throw err;
      }
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
      let result: Awaited<ReturnType<typeof listFeedback>>;
      try {
        result = await listFeedback({
          viewerId: userId,
          isAdmin,
          status: args.status,
          kind: args.kind,
          limit,
          offset: (page - 1) * limit,
        });
      } catch (err) {
        if (err instanceof FeedbackServiceError) {
          return errorResult(err.message);
        }
        throw err;
      }
      return structuredResult({
        feedback: result.items.map((item) => ({
          ...item,
          description: previewFeedbackDescription(item.description),
        })),
        total: result.total,
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
      let item: Awaited<ReturnType<typeof getFeedbackForViewer>>;
      try {
        item = await getFeedbackForViewer(args.id, {
          viewerId: userId,
          isAdmin: await userIsAdmin(userId),
        });
      } catch (err) {
        if (err instanceof FeedbackServiceError) {
          return errorResult(err.message);
        }
        throw err;
      }
      if (!item) {
        return errorResult(`Feedback '${args.id}' not found.`);
      }
      return structuredResult({ feedback: item });
    }
  );
}
