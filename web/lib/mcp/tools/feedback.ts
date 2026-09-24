import type { McpServer } from "@modelcontextprotocol/server";
import {
  createFeedback,
  listFeedback,
  updateFeedback,
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
  requireMcpAdmin,
  requireMcpWrite,
  structuredResult,
} from "@/lib/mcp/tools/helpers";
import {
  listFeedbackTool,
  sendFeedbackTool,
  updateFeedbackTool,
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
      return structuredResult({
        duplicate: result.duplicate,
        feedback: result.item,
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
      return structuredResult({ feedback: result.items, total: result.total });
    }
  );

  server.registerTool(
    updateFeedbackTool.name,
    toolRegistrationConfig(updateFeedbackTool),
    async (args, ctx) => {
      const authInfo = ctx.http?.authInfo;
      const writeError = requireMcpWrite(authInfo);
      if (writeError) {
        return writeError;
      }
      const adminError = await requireMcpAdmin(authInfo);
      if (adminError) {
        return adminError;
      }
      const userId = getMcpUserId(authInfo);
      if (!userId) {
        return errorResult("Authenticated user not available on this session.");
      }
      const note =
        args.note === undefined ? undefined : args.note.trim() || null;
      const updated = await updateFeedback({
        id: args.id,
        adminUserId: userId,
        status: args.status,
        note,
      });
      if (!updated) {
        return errorResult(`Feedback '${args.id}' not found.`);
      }
      return structuredResult({ feedback: updated });
    }
  );
}
