import { inArray } from "drizzle-orm";
import { after } from "next/server";
import { z } from "zod";
import {
  FEEDBACK_KIND_LABELS,
  FEEDBACK_LIST_DESCRIPTION_MAX,
  FEEDBACK_LIST_MAX,
  type FeedbackKind,
  type FeedbackSource,
  type FeedbackStatus,
  feedbackKindSchema,
  feedbackSourceSchema,
} from "@/lib/api/feedback-schema";
import { notifyFeedbackSubmitted } from "@/lib/api/notifications";
import { appOrigin } from "@/lib/app-origin";
import { db } from "@/lib/db";
import { oauthClients, users } from "@/lib/db/schema";
import {
  createLinearAttachment,
  createLinearIssue,
  type LinearIssueDetailNode,
  LinearRequestError,
  listLinearIssueDetails,
  listLinearIssueSummaries,
} from "@/lib/linear/client";
import { getLinearFeedbackSetup } from "@/lib/linear/config";
import {
  FEEDBACK_REPORT_MARKER,
  type FeedbackSummary,
  feedbackAttachmentUrl,
  feedbackReporterMarker,
  feedbackStatusFromLinearState,
  kindFromAttachmentUrl,
  pageFeedbackSummaries,
} from "@/lib/linear/feedback-link";

export const FEEDBACK_NOT_CONFIGURED_MESSAGE =
  "Feedback isn't set up on this Data Hub.";
export const FEEDBACK_UNAVAILABLE_MESSAGE =
  "Linear is unavailable. Try again later.";

const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;
const SUMMARY_PAGE_CAP = 20;

export class FeedbackServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedbackServiceError";
  }
}

export function previewFeedbackDescription(description: string): string {
  if (description.length <= FEEDBACK_LIST_DESCRIPTION_MAX) {
    return description;
  }
  return `${description.slice(0, FEEDBACK_LIST_DESCRIPTION_MAX).trimEnd()}…`;
}

export interface FeedbackPerson {
  email: string | null;
  id: string;
  name: string | null;
}

export interface FeedbackLinearIssue {
  identifier: string;
  stateName: string;
  url: string;
}

export interface FeedbackItem {
  adminNote: string | null;
  attemptedAction: string | null;
  createdAt: Date;
  description: string;
  errorMessage: string | null;
  id: string;
  kind: FeedbackKind;
  linearIssue: FeedbackLinearIssue;
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

const metadataSchema = z.object({
  attemptedAction: z.string().optional(),
  description: z.string(),
  errorMessage: z.string().optional(),
  kind: feedbackKindSchema,
  oauthClientId: z.string().optional(),
  pageUrl: z.string().optional(),
  reporterUserId: z.string(),
  source: feedbackSourceSchema,
  title: z.string(),
  toolName: z.string().optional(),
  version: z.number(),
});

function blankToNull(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  return value;
}

function reportAttachment(issue: LinearIssueDetailNode) {
  return (
    issue.attachments.nodes.find((attachment) =>
      attachment.url.includes(FEEDBACK_REPORT_MARKER)
    ) ?? null
  );
}

function toFeedbackItem(
  issue: LinearIssueDetailNode,
  people: Map<string, FeedbackPerson>,
  clientNames: Map<string, string | null>
): FeedbackItem | null {
  const attachment = reportAttachment(issue);
  if (!attachment) {
    return null;
  }
  const metadata = metadataSchema.safeParse(attachment.metadata);
  if (!metadata.success) {
    return null;
  }
  const status = feedbackStatusFromLinearState(issue.state.type);
  const statusUpdatedAt =
    status === "resolved"
      ? issue.completedAt
      : status === "declined"
        ? issue.canceledAt
        : null;
  const oauthClientId = blankToNull(metadata.data.oauthClientId);
  return {
    id: issue.id,
    kind: metadata.data.kind,
    title: metadata.data.title,
    description: metadata.data.description,
    attemptedAction: blankToNull(metadata.data.attemptedAction),
    toolName: blankToNull(metadata.data.toolName),
    errorMessage: blankToNull(metadata.data.errorMessage),
    source: metadata.data.source,
    oauthClientId,
    oauthClientName: oauthClientId
      ? (clientNames.get(oauthClientId) ?? null)
      : null,
    pageUrl: blankToNull(metadata.data.pageUrl),
    status,
    adminNote: null,
    statusUpdatedAt: statusUpdatedAt ? new Date(statusUpdatedAt) : null,
    statusUpdatedBy: null,
    createdAt: new Date(issue.createdAt),
    updatedAt: new Date(issue.updatedAt),
    reporter: people.get(metadata.data.reporterUserId) ?? null,
    linearIssue: {
      identifier: issue.identifier,
      url: issue.url,
      stateName: issue.state.name,
    },
  };
}

async function hydrate(
  issues: LinearIssueDetailNode[]
): Promise<FeedbackItem[]> {
  const parsed = issues.flatMap((issue) => {
    const attachment = reportAttachment(issue);
    const metadata = attachment
      ? metadataSchema.safeParse(attachment.metadata)
      : null;
    return metadata?.success ? [metadata.data] : [];
  });
  const reporterIds = [...new Set(parsed.map((item) => item.reporterUserId))];
  const clientIds = [
    ...new Set(
      parsed
        .map((item) => blankToNull(item.oauthClientId))
        .filter((id): id is string => id != null)
    ),
  ];

  const [peopleRows, clientRows] = await Promise.all([
    reporterIds.length > 0
      ? db
          .select({ id: users.id, name: users.name, email: users.email })
          .from(users)
          .where(inArray(users.id, reporterIds))
      : Promise.resolve([]),
    clientIds.length > 0
      ? db
          .select({ clientId: oauthClients.clientId, name: oauthClients.name })
          .from(oauthClients)
          .where(inArray(oauthClients.clientId, clientIds))
      : Promise.resolve([]),
  ]);

  const people = new Map(peopleRows.map((row) => [row.id, row]));
  const clientNames = new Map(
    clientRows.map((row) => [row.clientId, row.name])
  );
  return issues.flatMap((issue) => {
    const item = toFeedbackItem(issue, people, clientNames);
    return item ? [item] : [];
  });
}

async function requireSetup() {
  const setup = await getLinearFeedbackSetup();
  if (!setup) {
    throw new FeedbackServiceError(FEEDBACK_NOT_CONFIGURED_MESSAGE);
  }
  return setup;
}

function credentialsOf(setup: { clientId: string; clientSecret: string }) {
  return { clientId: setup.clientId, clientSecret: setup.clientSecret };
}

async function allSummaries(marker: string) {
  const setup = await requireSetup();
  const credentials = credentialsOf(setup);
  const summaries: FeedbackSummary[] = [];
  let after: string | undefined;
  for (let page = 0; page < SUMMARY_PAGE_CAP; page += 1) {
    const connection = await listLinearIssueSummaries(credentials, {
      after,
      filter: {
        attachments: { some: { url: { contains: marker } } },
      },
    });
    for (const node of connection.nodes) {
      const url = node.attachments.nodes.find((attachment) =>
        attachment.url.includes(marker)
      )?.url;
      const kind = url ? kindFromAttachmentUrl(url) : null;
      if (!kind) {
        continue;
      }
      summaries.push({
        id: node.id,
        createdAt: node.createdAt,
        kind,
        status: feedbackStatusFromLinearState(node.state.type),
      });
    }
    if (!(connection.pageInfo.hasNextPage && connection.pageInfo.endCursor)) {
      break;
    }
    after = connection.pageInfo.endCursor;
  }
  return summaries;
}

async function loadIssues(ids: string[]): Promise<FeedbackItem[]> {
  const setup = await requireSetup();
  const nodes = await listLinearIssueDetails(credentialsOf(setup), ids);
  const items = await hydrate(nodes);
  const byId = new Map(items.map((item) => [item.id, item]));
  return ids.flatMap((id) => {
    const item = byId.get(id);
    return item ? [item] : [];
  });
}

function issueDescription(input: {
  attemptedAction?: string;
  description: string;
  errorMessage?: string;
  kind: FeedbackKind;
  pageUrl?: string | null;
  reporterEmail: string | null;
  reporterName: string;
  source: FeedbackSource;
  toolName?: string;
}): string {
  const lines = [
    input.description,
    "",
    "---",
    "",
    `Kind: ${FEEDBACK_KIND_LABELS[input.kind]}`,
  ];
  if (input.attemptedAction) {
    lines.push(`Tried: ${input.attemptedAction}`);
  }
  if (input.errorMessage) {
    lines.push(`Error: ${input.errorMessage}`);
  }
  if (input.pageUrl) {
    lines.push(`Page: ${input.pageUrl}`);
  }
  if (input.toolName) {
    lines.push(`Tool: ${input.toolName}`);
  }
  lines.push(`Sent from: ${input.source}`);
  const reporter = input.reporterEmail
    ? `${input.reporterName} <${input.reporterEmail}>`
    : input.reporterName;
  lines.push(`Reporter: ${reporter}`);
  return lines.join("\n");
}

async function withLinear<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof FeedbackServiceError) {
      throw err;
    }
    if (err instanceof LinearRequestError) {
      throw new FeedbackServiceError(FEEDBACK_UNAVAILABLE_MESSAGE);
    }
    throw err;
  }
}

export function createFeedback(input: {
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
  return withLinear(async () => {
    const setup = await requireSetup();
    const credentials = credentialsOf(setup);
    const cutoff = new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString();
    const existing = await listLinearIssueSummaries(credentials, {
      filter: {
        attachments: {
          some: { url: { contains: feedbackReporterMarker(input.userId) } },
        },
        title: { eq: input.title },
        createdAt: { gte: cutoff },
        state: { type: { nin: ["completed", "canceled"] } },
      },
    });
    const duplicateId = existing.nodes[0]?.id;
    if (duplicateId) {
      const [item] = await loadIssues([duplicateId]);
      if (item) {
        return { item, duplicate: true };
      }
    }

    const [reporter] = await db
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(inArray(users.id, [input.userId]))
      .limit(1);
    const reporterName = reporter?.name ?? reporter?.email ?? "Data Hub user";
    const labelId = setup.labelIds[input.kind];
    const created = await createLinearIssue(credentials, {
      title: input.title,
      description: issueDescription({
        ...input,
        reporterName,
        reporterEmail: reporter?.email ?? null,
      }),
      teamId: setup.teamId,
      projectId: setup.projectId,
      labelIds: labelId ? [labelId] : [],
      createAsUser: reporterName,
    });

    const metadata = {
      version: 1,
      reporterUserId: input.userId,
      kind: input.kind,
      title: input.title,
      description: input.description,
      attemptedAction: input.attemptedAction ?? "",
      toolName: input.toolName ?? "",
      errorMessage: input.errorMessage ?? "",
      source: input.source,
      oauthClientId: input.oauthClientId ?? "",
      pageUrl: input.pageUrl ?? "",
    };
    const attachment = {
      issueId: created.id,
      title: "Data Hub feedback",
      url: feedbackAttachmentUrl({
        origin: appOrigin(),
        reporterId: input.userId,
        kind: input.kind,
        issueId: created.id,
      }),
      metadata,
    };
    try {
      await createLinearAttachment(credentials, attachment);
    } catch (err) {
      if (!(err instanceof LinearRequestError)) {
        throw err;
      }
      await createLinearAttachment(credentials, attachment);
    }

    const [item] = await loadIssues([created.id]);
    if (!item) {
      throw new FeedbackServiceError(FEEDBACK_UNAVAILABLE_MESSAGE);
    }

    const origin = appOrigin();
    after(async () => {
      await notifyFeedbackSubmitted({
        feedbackId: item.id,
        reporterUserId: input.userId,
        reporterDisplayName: reporterName,
        title: item.title,
        origin,
      });
    });

    return { item, duplicate: false };
  });
}

export function listFeedback(input: {
  isAdmin: boolean;
  kind?: FeedbackKind;
  limit: number;
  offset: number;
  status?: FeedbackStatus;
  viewerId: string;
}): Promise<{ items: FeedbackItem[]; total: number }> {
  return withLinear(async () => {
    const limit = Math.min(Math.max(input.limit, 1), FEEDBACK_LIST_MAX);
    const offset = Math.max(input.offset, 0);
    const marker = input.isAdmin
      ? FEEDBACK_REPORT_MARKER
      : feedbackReporterMarker(input.viewerId);
    const summaries = await allSummaries(marker);
    const page = pageFeedbackSummaries(summaries, {
      status: input.status,
      kind: input.kind,
      limit,
      offset,
    });
    return {
      items: await loadIssues(page.ids),
      total: page.total,
    };
  });
}

export function countFeedbackByStatus(input: {
  isAdmin: boolean;
  viewerId: string;
}): Promise<Record<FeedbackStatus, number>> {
  return withLinear(async () => {
    const marker = input.isAdmin
      ? FEEDBACK_REPORT_MARKER
      : feedbackReporterMarker(input.viewerId);
    const summaries = await allSummaries(marker);
    return pageFeedbackSummaries(summaries, {
      limit: 1,
      offset: 0,
    }).counts;
  });
}

export function getFeedbackForViewer(
  id: string,
  viewer: { isAdmin: boolean; viewerId: string }
): Promise<FeedbackItem | null> {
  return withLinear(async () => {
    const [item] = await loadIssues([id]);
    if (!item) {
      return null;
    }
    if (viewer.isAdmin || item.reporter?.id === viewer.viewerId) {
      return item;
    }
    return null;
  });
}
