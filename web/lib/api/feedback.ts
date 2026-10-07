import { inArray } from "drizzle-orm";
import { after } from "next/server";
import { LINEAR_UNAVAILABLE } from "@/lib/api/errors";
import {
  FEEDBACK_KIND_LABELS,
  FEEDBACK_LIST_DESCRIPTION_MAX,
  FEEDBACK_LIST_MAX,
  type FeedbackKind,
  type FeedbackSource,
  type FeedbackStatus,
} from "@/lib/api/feedback-schema";
import { notifyFeedbackSubmitted } from "@/lib/api/notifications";
import { appOrigin } from "@/lib/app-origin";
import { db } from "@/lib/db";
import { oauthClients, users } from "@/lib/db/schema";
import {
  createLinearAttachment,
  createLinearIssue,
  LINEAR_RATE_LIMITED,
  LINEAR_SUMMARY_PAGE_SIZE,
  type LinearIssueDetailNode,
  LinearRequestError,
  listLinearIssueDetails,
  listLinearIssueSummaries,
} from "@/lib/linear/client";
import {
  getLinearFeedbackSetup,
  type LinearFeedbackSetup,
} from "@/lib/linear/config";
import {
  FEEDBACK_REPORT_MARKER,
  type FeedbackReportMetadata,
  type FeedbackSummary,
  feedbackAttachmentUrl,
  feedbackIssueMarker,
  feedbackReporterMarker,
  feedbackStatusFromLinearState,
  kindFromAttachmentUrl,
  LINEAR_CLOSED_STATE_TYPES,
  pageFeedbackSummaries,
  readFeedbackReport,
} from "@/lib/linear/feedback-link";

export const FEEDBACK_NOT_CONFIGURED_MESSAGE =
  "Feedback isn't set up on this Data Hub.";
export const FEEDBACK_UNAVAILABLE_MESSAGE =
  "Linear is unavailable. Try again later.";
export const FEEDBACK_RATE_LIMITED_MESSAGE =
  "Linear is busy with other requests from Data Hub. Try again in a few minutes.";

export const FEEDBACK_NOT_CONFIGURED = "FEEDBACK_NOT_CONFIGURED";

const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;
// A page holds LINEAR_SUMMARY_PAGE_SIZE reports, so this reads up to 5,000.
const SUMMARY_PAGE_CAP = 50;
// Linear's issue-creation call can succeed while the attachment call that
// follows fails, so the attachment gets a second try before the request fails.
const ATTACHMENT_ATTEMPTS = 2;

// Shaped for `apiErrorFromResult`, like the other `{ ok: false, … }` helpers.
export interface FeedbackFailure {
  code: typeof LINEAR_UNAVAILABLE | typeof FEEDBACK_NOT_CONFIGURED;
  message: string;
  ok: false;
  status: 502 | 503;
}

export type FeedbackResult<T extends object> =
  | ({ ok: true } & T)
  | FeedbackFailure;

const NOT_CONFIGURED_FAILURE: FeedbackFailure = {
  ok: false,
  status: 503,
  code: FEEDBACK_NOT_CONFIGURED,
  message: FEEDBACK_NOT_CONFIGURED_MESSAGE,
};

function linearFailure(err: LinearRequestError): FeedbackFailure {
  return {
    ok: false,
    status: 502,
    code: LINEAR_UNAVAILABLE,
    message:
      err.code === LINEAR_RATE_LIMITED
        ? FEEDBACK_RATE_LIMITED_MESSAGE
        : FEEDBACK_UNAVAILABLE_MESSAGE,
  };
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
  title: string;
  toolName: string | null;
  updatedAt: Date;
}

// An issue paired with its checked Data Hub metadata. Reading it once here
// keeps the checks and the lookups that follow from drifting apart.
interface Report {
  issue: LinearIssueDetailNode;
  metadata: FeedbackReportMetadata;
}

function blankToNull(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  return value;
}

function readReport(issue: LinearIssueDetailNode): Report | null {
  const metadata = readFeedbackReport(issue);
  return metadata ? { issue, metadata } : null;
}

function toFeedbackItem(
  { issue, metadata }: Report,
  people: Map<string, FeedbackPerson>,
  clientNames: Map<string, string | null>
): FeedbackItem {
  const status = feedbackStatusFromLinearState(issue.state.type);
  const statusUpdatedAt =
    status === "resolved"
      ? issue.completedAt
      : status === "declined"
        ? issue.canceledAt
        : null;
  const oauthClientId = blankToNull(metadata.oauthClientId);
  return {
    id: issue.id,
    kind: metadata.kind,
    title: metadata.title,
    description: metadata.description,
    attemptedAction: blankToNull(metadata.attemptedAction),
    toolName: blankToNull(metadata.toolName),
    errorMessage: blankToNull(metadata.errorMessage),
    source: metadata.source,
    oauthClientId,
    oauthClientName: oauthClientId
      ? (clientNames.get(oauthClientId) ?? null)
      : null,
    pageUrl: blankToNull(metadata.pageUrl),
    status,
    statusUpdatedAt: statusUpdatedAt ? new Date(statusUpdatedAt) : null,
    createdAt: new Date(issue.createdAt),
    updatedAt: new Date(issue.updatedAt),
    reporter: people.get(metadata.reporterUserId) ?? null,
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
  const reports = issues.flatMap((issue) => {
    const report = readReport(issue);
    return report ? [report] : [];
  });
  const reporterIds = [
    ...new Set(reports.map(({ metadata }) => metadata.reporterUserId)),
  ];
  const clientIds = [
    ...new Set(
      reports
        .map(({ metadata }) => blankToNull(metadata.oauthClientId))
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
  return reports.map((report) => toFeedbackItem(report, people, clientNames));
}

// Runs `run` with the saved Linear setup and turns the two ways it can fail
// into `{ ok: false }` results, so routes and tools never catch them.
async function withSetup<T extends object>(
  run: (setup: LinearFeedbackSetup) => Promise<T>
): Promise<FeedbackResult<T>> {
  const setup = await getLinearFeedbackSetup();
  if (!setup) {
    return NOT_CONFIGURED_FAILURE;
  }
  try {
    return { ok: true, ...(await run(setup)) };
  } catch (err) {
    if (err instanceof LinearRequestError) {
      return linearFailure(err);
    }
    throw err;
  }
}

// Reads every report summary, newest page last. Stops at the page cap and
// says so, because a silent stop would hide reports without any sign.
async function allSummaries(setup: LinearFeedbackSetup, marker: string) {
  const summaries: FeedbackSummary[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < SUMMARY_PAGE_CAP; page += 1) {
    const connection = await listLinearIssueSummaries(setup, {
      after: cursor,
      filter: {
        attachments: { some: { url: { contains: marker } } },
      },
    });
    for (const node of connection.nodes) {
      const url = node.attachments.nodes[0]?.url;
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
      return summaries;
    }
    cursor = connection.pageInfo.endCursor;
  }
  console.warn(
    `[feedback] Stopped reading Linear after ${SUMMARY_PAGE_CAP * LINEAR_SUMMARY_PAGE_SIZE} reports. Older reports are missing from the list and the counts.`
  );
  return summaries;
}

async function loadIssues(
  setup: LinearFeedbackSetup,
  ids: string[]
): Promise<FeedbackItem[]> {
  const nodes = await listLinearIssueDetails(setup, ids);
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
  reporterId: string;
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
  lines.push(
    `Reporter: ${reporter}`,
    feedbackIssueMarker({ kind: input.kind, reporterId: input.reporterId })
  );
  return lines.join("\n");
}

// Looks for the same reporter's open report with the same title. A complete
// match is a duplicate. A match with no Data Hub attachment is an issue whose
// attachment call failed earlier, which the caller finishes instead of
// opening a second issue.
async function findOpenReport(
  setup: LinearFeedbackSetup,
  input: { kind: FeedbackKind; title: string; userId: string }
): Promise<{ attached: string | null; unattached: string | null }> {
  const cutoff = new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString();
  const { nodes } = await listLinearIssueSummaries(setup, {
    pageSize: 5,
    filter: {
      title: { eq: input.title },
      createdAt: { gte: cutoff },
      state: { type: { nin: [...LINEAR_CLOSED_STATE_TYPES] } },
      or: [
        {
          attachments: {
            some: { url: { contains: feedbackReporterMarker(input.userId) } },
          },
        },
        {
          description: {
            contains: feedbackIssueMarker({
              kind: input.kind,
              reporterId: input.userId,
            }),
          },
        },
      ],
    },
  });
  return {
    attached:
      nodes.find((node) => node.attachments.nodes.length > 0)?.id ?? null,
    unattached:
      nodes.find((node) => node.attachments.nodes.length === 0)?.id ?? null,
  };
}

async function attachReport(
  setup: LinearFeedbackSetup,
  attachment: Parameters<typeof createLinearAttachment>[1],
  identifier: string | null
): Promise<void> {
  for (let attempt = 1; attempt <= ATTACHMENT_ATTEMPTS; attempt += 1) {
    try {
      await createLinearAttachment(setup, attachment);
      return;
    } catch (err) {
      if (!(err instanceof LinearRequestError)) {
        throw err;
      }
      if (attempt === ATTACHMENT_ATTEMPTS) {
        // Data Hub's token cannot delete the issue (`issues:create` does not
        // cover it), so the issue stays until the reporter sends the same
        // report again, which finishes it. Log it so an admin can find it.
        console.error(
          `[feedback] Linear issue ${identifier ?? attachment.issueId} has no Data Hub attachment.`
        );
        throw err;
      }
    }
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
}): Promise<FeedbackResult<{ duplicate: boolean; item: FeedbackItem }>> {
  return withSetup(async (setup) => {
    const existing = await findOpenReport(setup, input);
    if (existing.attached) {
      const [item] = await loadIssues(setup, [existing.attached]);
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

    let issueId = existing.unattached;
    let identifier: string | null = null;
    if (!issueId) {
      const labelId = setup.labelIds[input.kind];
      const created = await createLinearIssue(setup, {
        title: input.title,
        description: issueDescription({
          ...input,
          reporterId: input.userId,
          reporterName,
          reporterEmail: reporter?.email ?? null,
        }),
        teamId: setup.teamId,
        projectId: setup.projectId,
        labelIds: labelId ? [labelId] : [],
        createAsUser: reporterName,
      });
      issueId = created.id;
      identifier = created.identifier;
    }

    await attachReport(
      setup,
      {
        issueId,
        title: "Data Hub feedback",
        url: feedbackAttachmentUrl({
          origin: appOrigin(),
          reporterId: input.userId,
          kind: input.kind,
          issueId,
        }),
        metadata: {
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
        },
      },
      identifier
    );

    const [item] = await loadIssues(setup, [issueId]);
    if (!item) {
      throw new LinearRequestError("Linear did not return the new report.");
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

// One Linear read serves the page, the total, and the counts, so a list
// request costs one summary query and one details query.
export function listFeedback(input: {
  isAdmin: boolean;
  kind?: FeedbackKind;
  limit: number;
  offset: number;
  status?: FeedbackStatus;
  viewerId: string;
}): Promise<
  FeedbackResult<{
    counts: Record<FeedbackStatus, number>;
    items: FeedbackItem[];
    total: number;
  }>
> {
  return withSetup(async (setup) => {
    const limit = Math.min(Math.max(input.limit, 1), FEEDBACK_LIST_MAX);
    const offset = Math.max(input.offset, 0);
    const marker = input.isAdmin
      ? FEEDBACK_REPORT_MARKER
      : feedbackReporterMarker(input.viewerId);
    const summaries = await allSummaries(setup, marker);
    const page = pageFeedbackSummaries(summaries, {
      status: input.status,
      kind: input.kind,
      limit,
      offset,
    });
    return {
      items: await loadIssues(setup, page.ids),
      total: page.total,
      counts: page.counts,
    };
  });
}

export function getFeedbackForViewer(
  id: string,
  viewer: { isAdmin: boolean; viewerId: string }
): Promise<FeedbackResult<{ item: FeedbackItem | null }>> {
  return withSetup(async (setup) => {
    const [item] = await loadIssues(setup, [id]);
    if (item && (viewer.isAdmin || item.reporter?.id === viewer.viewerId)) {
      return { item };
    }
    return { item: null };
  });
}
