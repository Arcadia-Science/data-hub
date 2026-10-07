import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { after } from "next/server";
import { LINEAR_UNAVAILABLE } from "@/lib/api/errors";
import {
  FEEDBACK_KIND_LABELS,
  FEEDBACK_LIST_DESCRIPTION_MAX,
  FEEDBACK_LIST_MAX,
  type FeedbackKind,
  type FeedbackListStatus,
  type FeedbackSource,
  type FeedbackStatus,
} from "@/lib/api/feedback-schema";
import { notifyFeedbackSubmitted } from "@/lib/api/notifications";
import { appOrigin } from "@/lib/app-origin";
import { db } from "@/lib/db";
import {
  notificationPreferences,
  notifications,
  oauthClients,
  users,
} from "@/lib/db/schema";
import {
  createLinearAttachment,
  createLinearIssue,
  getLinearIssueActivity,
  getLinearIssueDetail,
  LINEAR_RATE_LIMITED,
  LINEAR_SUMMARY_PAGE_SIZE,
  type LinearIssueDetailNode,
  type LinearIssueLabel,
  LinearRequestError,
  listLinearIssueDetails,
  listLinearIssueSummaries,
} from "@/lib/linear/client";
import {
  getLinearConfigForAdmin,
  getLinearFeedbackSetup,
  type LinearFeedbackSetup,
} from "@/lib/linear/config";
import {
  FEEDBACK_REPORT_MARKER,
  type FeedbackCounts,
  type FeedbackReportMetadata,
  type FeedbackStateGroup,
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
import type { LinearWebhookRejectionReason } from "@/lib/linear/webhook";

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

export interface FeedbackAssignee {
  avatarUrl: string | null;
  email: string | null;
  name: string;
  userId: string;
}

export type FeedbackLabel = LinearIssueLabel;

export interface FeedbackLinearIssue {
  assignee: FeedbackAssignee | null;
  identifier: string;
  labels: FeedbackLabel[];
  priority: number | null;
  priorityLabel: string | null;
  projectName: string | null;
  stateColor: string;
  stateId: string;
  stateName: string;
  stateType: string;
  teamName: string;
  url: string;
}

export interface FeedbackActivityEvent {
  actorName: string | null;
  at: string;
  body: string | null;
  fromState: string | null;
  kind: "comment" | "status";
  toState: string | null;
  // The color of the state a status change moved to. Null on a comment.
  toStateColor: string | null;
}

export interface FeedbackItem {
  activity: FeedbackActivityEvent[] | null;
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

interface AssigneeMatch {
  email: string | null;
  id: string;
  image: string | null;
  name: string | null;
}

function toFeedbackItem(
  { issue, metadata }: Report,
  people: Map<string, FeedbackPerson>,
  clientNames: Map<string, string | null>,
  assigneesByEmail: Map<string, AssigneeMatch>
): FeedbackItem {
  const status = feedbackStatusFromLinearState(issue.state.type);
  const statusUpdatedAt =
    status === "resolved"
      ? issue.completedAt
      : status === "declined"
        ? issue.canceledAt
        : null;
  const oauthClientId = blankToNull(metadata.oauthClientId);
  const linearAssignee = issue.assignee;
  const matched = linearAssignee?.email
    ? assigneesByEmail.get(linearAssignee.email.toLowerCase())
    : undefined;
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
    activity: null,
    linearIssue: {
      identifier: issue.identifier,
      url: issue.url,
      stateId: issue.state.id,
      stateName: issue.state.name,
      stateType: issue.state.type,
      stateColor: issue.state.color,
      priority: issue.priority,
      priorityLabel: issue.priorityLabel,
      labels: issue.labels.nodes,
      projectName: issue.project?.name ?? null,
      teamName: issue.team.name,
      assignee: linearAssignee
        ? {
            userId: matched?.id ?? linearAssignee.id,
            name: matched?.name ?? linearAssignee.name,
            email: linearAssignee.email,
            avatarUrl: matched?.image ?? linearAssignee.avatarUrl,
          }
        : null,
    },
  };
}

// Reporters see their own report's status, Linear ID, and label. Assignee,
// priority, and the activity list stay with admins.
export function presentFeedback(
  item: FeedbackItem,
  isAdmin: boolean
): FeedbackItem {
  if (isAdmin) {
    return item;
  }
  return {
    ...item,
    activity: null,
    linearIssue: {
      ...item.linearIssue,
      assignee: null,
      priority: null,
      priorityLabel: null,
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
  const assigneeEmails = [
    ...new Set(
      reports.flatMap(({ issue }) => {
        const email = issue.assignee?.email?.toLowerCase();
        return email ? [email] : [];
      })
    ),
  ];

  const [peopleRows, clientRows, assigneeRows] = await Promise.all([
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
    assigneeEmails.length > 0
      ? db
          .select({
            id: users.id,
            name: users.name,
            email: users.email,
            image: users.image,
          })
          .from(users)
          .where(inArray(sql`lower(${users.email})`, assigneeEmails))
      : Promise.resolve([]),
  ]);

  const people = new Map(peopleRows.map((row) => [row.id, row]));
  const clientNames = new Map(
    clientRows.map((row) => [row.clientId, row.name])
  );
  const assigneesByEmail = new Map(
    assigneeRows.flatMap((row) => {
      const email = row.email?.toLowerCase();
      return email ? [[email, row] as const] : [];
    })
  );
  return reports.map((report) =>
    toFeedbackItem(report, people, clientNames, assigneesByEmail)
  );
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
        state: {
          id: node.state.id,
          name: node.state.name,
          color: node.state.color,
          type: node.state.type,
          position: node.state.position,
        },
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

export function issueDescription(input: {
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
    `Type: ${FEEDBACK_KIND_LABELS[input.kind]}`,
  ];
  if (input.attemptedAction) {
    lines.push(`Trying to do: ${input.attemptedAction}`);
  }
  if (input.errorMessage) {
    lines.push(`Error message: ${input.errorMessage}`);
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
  isTest?: boolean;
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
          ...(input.isTest ? { test: 1 } : {}),
        },
      },
      identifier
    );

    const [item] = await loadIssues(setup, [issueId]);
    if (!item) {
      throw new LinearRequestError("Linear did not return the new report.");
    }

    if (!input.isTest) {
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
    }

    return { item, duplicate: false };
  });
}

export const TEST_FEEDBACK_TITLE = "Test report from Data Hub";
export const TEST_FEEDBACK_DESCRIPTION =
  "Sent from Linear setup to check that a report, a status update, and a notification all arrive.";

export function createTestFeedback(
  userId: string
): Promise<FeedbackResult<{ duplicate: boolean; item: FeedbackItem }>> {
  return createFeedback({
    userId,
    kind: "other",
    title: TEST_FEEDBACK_TITLE,
    description: TEST_FEEDBACK_DESCRIPTION,
    source: "web",
    isTest: true,
  });
}

// One Linear read serves the page, the total, and the counts, so a list
// request costs one summary query and one details query.
export function listFeedback(input: {
  isAdmin: boolean;
  kind?: FeedbackKind;
  limit: number;
  offset: number;
  status?: FeedbackListStatus;
  viewerId: string;
}): Promise<
  FeedbackResult<{
    counts: FeedbackCounts;
    groups: FeedbackStateGroup[];
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
    const items = await loadIssues(setup, page.ids);
    return {
      items: items.map((item) => presentFeedback(item, input.isAdmin)),
      total: page.total,
      counts: page.counts,
      groups: page.groups,
    };
  });
}

async function loadActivity(
  setup: LinearFeedbackSetup,
  issueId: string
): Promise<FeedbackActivityEvent[]> {
  const activity = await getLinearIssueActivity(setup, issueId);
  if (!activity) {
    return [];
  }
  const events: FeedbackActivityEvent[] = [
    ...activity.statusChanges.map((change) => ({
      kind: "status" as const,
      at: change.at,
      actorName: change.actorName,
      fromState: change.fromState,
      toState: change.toState,
      toStateColor: change.toStateColor,
      body: null,
    })),
    ...activity.comments.map((comment) => ({
      kind: "comment" as const,
      at: comment.at,
      actorName: comment.userName,
      fromState: null,
      toState: null,
      toStateColor: null,
      body: comment.body,
    })),
  ];
  events.sort((left, right) => left.at.localeCompare(right.at));
  return events;
}

// `id` is the report's UUID or its Linear ID, such as ENG-1476.
export function getFeedbackForViewer(
  id: string,
  viewer: { isAdmin: boolean; viewerId: string }
): Promise<FeedbackResult<{ item: FeedbackItem | null }>> {
  return withSetup(async (setup) => {
    const issue = await getLinearIssueDetail(setup, id);
    if (!issue) {
      return { item: null };
    }
    const [item] = await hydrate([issue]);
    if (!(item && (viewer.isAdmin || item.reporter?.id === viewer.viewerId))) {
      return { item: null };
    }
    const loaded = viewer.isAdmin
      ? { ...item, activity: await loadActivity(setup, issue.id) }
      : item;
    return { item: presentFeedback(loaded, viewer.isAdmin) };
  });
}

export interface TestReportStatus {
  closed: boolean;
  id: string;
  identifier: string;
  labelName: string | null;
  notificationAt: string | null;
  notificationsEnabled: boolean;
  rejectionReason: LinearWebhookRejectionReason | null;
  rejections: number;
  stateName: string;
  stateType: string;
  teamName: string;
  updateReceived: boolean;
  url: string;
}

// Only the admin who sent the test report can read its progress, and only
// while the issue is still marked as that test.
export function getTestReportStatus(input: {
  issueId: string;
  userId: string;
}): Promise<FeedbackResult<{ status: TestReportStatus | null }>> {
  return withSetup(async (setup) => {
    const issue = await getLinearIssueDetail(setup, input.issueId);
    const report = issue ? readFeedbackReport(issue) : null;
    if (
      !(
        issue &&
        report &&
        report.test === 1 &&
        report.reporterUserId === input.userId
      )
    ) {
      return { status: null };
    }

    const [config, [note], [prefs]] = await Promise.all([
      getLinearConfigForAdmin(),
      db
        .select({ createdAt: notifications.createdAt })
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, input.userId),
            eq(notifications.feedbackId, issue.id),
            eq(notifications.type, "feedback_updated")
          )
        )
        .orderBy(desc(notifications.createdAt))
        .limit(1),
      db
        .select({ enabled: notificationPreferences.feedbackUpdatedEnabled })
        .from(notificationPreferences)
        .where(eq(notificationPreferences.userId, input.userId))
        .limit(1),
    ]);
    const closedAt = issue.completedAt ?? issue.canceledAt;
    const updateReceived = Boolean(
      closedAt &&
        config.lastWebhookAt &&
        config.lastWebhookAt.getTime() >= new Date(closedAt).getTime()
    );

    return {
      status: {
        id: issue.id,
        identifier: issue.identifier,
        url: issue.url,
        stateName: issue.state.name,
        stateType: issue.state.type,
        teamName: issue.team.name,
        labelName: issue.labels.nodes[0]?.name ?? null,
        closed: feedbackStatusFromLinearState(issue.state.type) !== "open",
        updateReceived,
        notificationAt: note?.createdAt.toISOString() ?? null,
        notificationsEnabled: prefs ? prefs.enabled : true,
        rejections: config.webhookRejections,
        rejectionReason: config.lastWebhookRejectionReason,
      },
    };
  });
}
