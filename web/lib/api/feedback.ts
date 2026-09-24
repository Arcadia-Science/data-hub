import { aliasedTable, and, count, desc, eq, gte } from "drizzle-orm";
import { after } from "next/server";
import {
  FEEDBACK_LIST_MAX,
  type FeedbackKind,
  type FeedbackSource,
  type FeedbackStatus,
} from "@/lib/api/feedback-schema";
import {
  notifyFeedbackSubmitted,
  notifyFeedbackUpdated,
} from "@/lib/api/notifications";
import { db } from "@/lib/db";
import { feedback, oauthClients, users } from "@/lib/db/schema";

const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface FeedbackPerson {
  email: string | null;
  id: string;
  name: string | null;
}

export interface FeedbackItem {
  adminNote: string | null;
  attemptedAction: string | null;
  createdAt: Date;
  description: string;
  errorMessage: string | null;
  id: string;
  kind: FeedbackKind;
  oauthClientId: string | null;
  oauthClientName: string | null;
  pageUrl: string | null;
  reporter: FeedbackPerson | null;
  source: FeedbackSource;
  status: FeedbackStatus;
  statusUpdatedAt: Date | null;
  statusUpdatedBy: FeedbackPerson | null;
  title: string;
  toolName: string | null;
  updatedAt: Date;
}

const reporter = aliasedTable(users, "feedback_reporter");
const statusEditor = aliasedTable(users, "feedback_status_editor");

function person(
  id: string | null,
  name: string | null,
  email: string | null
): FeedbackPerson | null {
  if (!id) {
    return null;
  }
  return { id, name, email };
}

function appOrigin(): string | undefined {
  const configured = process.env.BETTER_AUTH_URL?.replace(/\/$/, "");
  if (configured) {
    return configured;
  }
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  return;
}

async function loadFeedback(id: string): Promise<FeedbackItem | null> {
  const [row] = await db
    .select({
      id: feedback.id,
      kind: feedback.kind,
      title: feedback.title,
      description: feedback.description,
      attemptedAction: feedback.attemptedAction,
      toolName: feedback.toolName,
      errorMessage: feedback.errorMessage,
      source: feedback.source,
      oauthClientId: feedback.oauthClientId,
      oauthClientName: oauthClients.name,
      pageUrl: feedback.pageUrl,
      status: feedback.status,
      adminNote: feedback.adminNote,
      statusUpdatedAt: feedback.statusUpdatedAt,
      createdAt: feedback.createdAt,
      updatedAt: feedback.updatedAt,
      reporterId: reporter.id,
      reporterName: reporter.name,
      reporterEmail: reporter.email,
      editorId: statusEditor.id,
      editorName: statusEditor.name,
      editorEmail: statusEditor.email,
    })
    .from(feedback)
    .leftJoin(reporter, eq(reporter.id, feedback.userId))
    .leftJoin(statusEditor, eq(statusEditor.id, feedback.statusUpdatedBy))
    .leftJoin(oauthClients, eq(oauthClients.clientId, feedback.oauthClientId))
    .where(eq(feedback.id, id))
    .limit(1);

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    description: row.description,
    attemptedAction: row.attemptedAction,
    toolName: row.toolName,
    errorMessage: row.errorMessage,
    source: row.source,
    oauthClientId: row.oauthClientId,
    oauthClientName: row.oauthClientName,
    pageUrl: row.pageUrl,
    status: row.status,
    adminNote: row.adminNote,
    statusUpdatedAt: row.statusUpdatedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    reporter: person(row.reporterId, row.reporterName, row.reporterEmail),
    statusUpdatedBy: person(row.editorId, row.editorName, row.editorEmail),
  };
}

export async function createFeedback(input: {
  attemptedAction?: string;
  description: string;
  errorMessage?: string;
  kind: FeedbackKind;
  oauthClientId?: string | null;
  pageUrl?: string | null;
  source: FeedbackSource;
  title: string;
  toolName?: string;
  userId: string;
}): Promise<{ duplicate: boolean; item: FeedbackItem }> {
  const cutoff = new Date(Date.now() - DUPLICATE_WINDOW_MS);
  const [existing] = await db
    .select({ id: feedback.id })
    .from(feedback)
    .where(
      and(
        eq(feedback.userId, input.userId),
        eq(feedback.title, input.title),
        eq(feedback.status, "open"),
        gte(feedback.createdAt, cutoff)
      )
    )
    .orderBy(desc(feedback.createdAt))
    .limit(1);

  if (existing) {
    const item = await loadFeedback(existing.id);
    if (item) {
      return { item, duplicate: true };
    }
  }

  const [inserted] = await db
    .insert(feedback)
    .values({
      userId: input.userId,
      kind: input.kind,
      title: input.title,
      description: input.description,
      attemptedAction: input.attemptedAction ?? null,
      toolName: input.toolName ?? null,
      errorMessage: input.errorMessage ?? null,
      source: input.source,
      oauthClientId: input.oauthClientId ?? null,
      pageUrl: input.pageUrl ?? null,
    })
    .returning({ id: feedback.id });

  const item = await loadFeedback(inserted.id);
  if (!item) {
    throw new Error("Inserted feedback row could not be reloaded.");
  }

  const origin = appOrigin();
  after(async () => {
    const [user] = await db
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1);
    await notifyFeedbackSubmitted({
      feedbackId: item.id,
      reporterUserId: input.userId,
      reporterDisplayName: user?.name ?? user?.email ?? "Someone",
      title: item.title,
      origin,
    });
  });

  return { item, duplicate: false };
}

function viewerFilter(viewerId: string, isAdmin: boolean) {
  return isAdmin ? undefined : eq(feedback.userId, viewerId);
}

export async function listFeedback(input: {
  isAdmin: boolean;
  kind?: FeedbackKind;
  limit: number;
  offset: number;
  status?: FeedbackStatus;
  viewerId: string;
}): Promise<{ items: FeedbackItem[]; total: number }> {
  const limit = Math.min(Math.max(input.limit, 1), FEEDBACK_LIST_MAX);
  const offset = Math.max(input.offset, 0);
  const where = and(
    viewerFilter(input.viewerId, input.isAdmin),
    input.status ? eq(feedback.status, input.status) : undefined,
    input.kind ? eq(feedback.kind, input.kind) : undefined
  );

  const [totalRow, rows] = await Promise.all([
    db.select({ total: count() }).from(feedback).where(where),
    db
      .select({
        id: feedback.id,
        kind: feedback.kind,
        title: feedback.title,
        description: feedback.description,
        attemptedAction: feedback.attemptedAction,
        toolName: feedback.toolName,
        errorMessage: feedback.errorMessage,
        source: feedback.source,
        oauthClientId: feedback.oauthClientId,
        oauthClientName: oauthClients.name,
        pageUrl: feedback.pageUrl,
        status: feedback.status,
        adminNote: feedback.adminNote,
        statusUpdatedAt: feedback.statusUpdatedAt,
        createdAt: feedback.createdAt,
        updatedAt: feedback.updatedAt,
        reporterId: reporter.id,
        reporterName: reporter.name,
        reporterEmail: reporter.email,
        editorId: statusEditor.id,
        editorName: statusEditor.name,
        editorEmail: statusEditor.email,
      })
      .from(feedback)
      .leftJoin(reporter, eq(reporter.id, feedback.userId))
      .leftJoin(statusEditor, eq(statusEditor.id, feedback.statusUpdatedBy))
      .leftJoin(oauthClients, eq(oauthClients.clientId, feedback.oauthClientId))
      .where(where)
      .orderBy(desc(feedback.createdAt))
      .limit(limit)
      .offset(offset),
  ]);

  return {
    items: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      description: row.description,
      attemptedAction: row.attemptedAction,
      toolName: row.toolName,
      errorMessage: row.errorMessage,
      source: row.source,
      oauthClientId: row.oauthClientId,
      oauthClientName: row.oauthClientName,
      pageUrl: row.pageUrl,
      status: row.status,
      adminNote: row.adminNote,
      statusUpdatedAt: row.statusUpdatedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      reporter: person(row.reporterId, row.reporterName, row.reporterEmail),
      statusUpdatedBy: person(row.editorId, row.editorName, row.editorEmail),
    })),
    total: totalRow[0]?.total ?? 0,
  };
}

export async function countFeedbackByStatus(input: {
  isAdmin: boolean;
  viewerId: string;
}): Promise<Record<FeedbackStatus, number>> {
  const rows = await db
    .select({
      status: feedback.status,
      total: count(),
    })
    .from(feedback)
    .where(viewerFilter(input.viewerId, input.isAdmin))
    .groupBy(feedback.status);

  const counts: Record<FeedbackStatus, number> = {
    open: 0,
    resolved: 0,
    declined: 0,
  };
  for (const row of rows) {
    counts[row.status] = row.total;
  }
  return counts;
}

export async function getFeedbackForViewer(
  id: string,
  viewer: { isAdmin: boolean; viewerId: string }
): Promise<FeedbackItem | null> {
  const item = await loadFeedback(id);
  if (!item) {
    return null;
  }
  if (viewer.isAdmin || item.reporter?.id === viewer.viewerId) {
    return item;
  }
  return null;
}

export async function updateFeedback(input: {
  adminUserId: string;
  id: string;
  note?: string | null;
  status: FeedbackStatus;
}): Promise<FeedbackItem | null> {
  const current = await loadFeedback(input.id);
  if (!current) {
    return null;
  }

  const note = input.note === undefined ? current.adminNote : input.note;
  if (current.status === input.status && current.adminNote === note) {
    return current;
  }

  await db
    .update(feedback)
    .set({
      status: input.status,
      adminNote: note,
      statusUpdatedBy: input.adminUserId,
      statusUpdatedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(feedback.id, input.id));

  const updated = await loadFeedback(input.id);
  if (!updated) {
    return null;
  }

  if (
    updated.reporter &&
    (input.status === "resolved" || input.status === "declined")
  ) {
    const reporterUserId = updated.reporter.id;
    const status = input.status;
    after(async () => {
      await notifyFeedbackUpdated({
        feedbackId: updated.id,
        reporterUserId,
        adminUserId: input.adminUserId,
        title: updated.title,
        status,
        note,
      });
    });
  }

  return updated;
}
