// Saved Linear OAuth app settings. Client secret and webhook signing secret
// are encrypted. Nothing falls back to an environment variable: Linear is
// off until an admin saves a client ID, client secret, and team.

import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  type FeedbackKind,
  feedbackKindSchema,
} from "@/lib/api/feedback-schema";
import {
  inspectSavedSecret,
  readMaybeEncryptedSecret,
} from "@/lib/crypto/integration-secrets";
import { db } from "@/lib/db";
import {
  linearIntegrationConfig,
  linearWebhookDeliveries,
  users,
} from "@/lib/db/schema";
import { nextSecret } from "@/lib/integrations/config-patch";
import {
  type PlainFieldStatus,
  plainFieldStatus,
  resolveIntegrationField,
  type SecretFieldStatus,
  savedPlainValue,
  secretFieldStatus,
} from "@/lib/integrations/field-status";
import {
  type LastUpdated,
  lastUpdatedByColumns,
  toLastUpdated,
} from "@/lib/integrations/last-updated";
import {
  clearLinearTokenCache,
  type LinearChoice,
  type LinearCredentials,
  type LinearOrganization,
  listLinearTeamOptions,
  listLinearTeams,
  testLinearConnection,
} from "./client";
import type { LinearWebhookRejectionReason } from "./webhook";

const optionalText = z.string().trim().min(1).nullable().optional();

export const linearChoiceSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1),
  key: z.string().trim().min(1).optional(),
  url: z.string().trim().min(1).optional(),
});

export type LinearLabelChoices = Record<FeedbackKind, LinearChoice | null>;

const optionalChoice = linearChoiceSchema.nullable().optional();

// Strict so a client that still sends `client_id` or `client_secret` gets a
// 400. Credentials are saved only through the connect route.
export const linearConfigPutBodySchema = z
  .strictObject({
    webhook_secret: optionalText,
    team: optionalChoice,
    project: optionalChoice,
    labels: z
      .partialRecord(feedbackKindSchema, linearChoiceSchema.nullable())
      .optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: "No Linear settings to save",
  });

export type LinearConfigPutBody = z.infer<typeof linearConfigPutBodySchema>;

export const linearConnectBodySchema = z.object({
  client_id: z.string().trim().min(1),
  client_secret: z.string().trim().min(1),
  confirm_workspace_change: z.boolean().optional(),
});

export class LinearWorkspaceChangeError extends Error {
  readonly workspaceId: string;
  readonly workspaceName: string;

  constructor(workspaceId: string, workspaceName: string) {
    super(workspaceName);
    this.name = "LinearWorkspaceChangeError";
    this.workspaceId = workspaceId;
    this.workspaceName = workspaceName;
  }
}

export interface LinearConfigForAdmin {
  clientId: PlainFieldStatus;
  clientSecret: SecretFieldStatus;
  labels: LinearLabelChoices;
  lastUpdated: LastUpdated | null;
  lastWebhookAt: Date | null;
  lastWebhookRejectedAt: Date | null;
  lastWebhookRejectionReason: LinearWebhookRejectionReason | null;
  project: LinearChoice | null;
  projectUrl: string | null;
  team: LinearChoice | null;
  teamKey: string | null;
  webhookRejections: number;
  webhookSecret: SecretFieldStatus;
  workspaceId: string | null;
  workspaceName: string | null;
  workspaceUrlKey: string | null;
}

export interface SavedLinearCredentials extends LinearCredentials {
  webhookSecret: string | null;
}

function choice(
  id: string | null | undefined,
  name: string | null | undefined
): LinearChoice | null {
  if (!(id && name)) {
    return null;
  }
  return { id, name };
}

const configColumns = {
  clientId: linearIntegrationConfig.clientId,
  clientSecret: linearIntegrationConfig.clientSecret,
  webhookSecret: linearIntegrationConfig.webhookSecret,
  teamId: linearIntegrationConfig.teamId,
  teamName: linearIntegrationConfig.teamName,
  projectId: linearIntegrationConfig.projectId,
  projectName: linearIntegrationConfig.projectName,
  bugLabelId: linearIntegrationConfig.bugLabelId,
  bugLabelName: linearIntegrationConfig.bugLabelName,
  featureLabelId: linearIntegrationConfig.featureLabelId,
  featureLabelName: linearIntegrationConfig.featureLabelName,
  otherLabelId: linearIntegrationConfig.otherLabelId,
  otherLabelName: linearIntegrationConfig.otherLabelName,
  workspaceId: linearIntegrationConfig.workspaceId,
  workspaceName: linearIntegrationConfig.workspaceName,
  workspaceUrlKey: linearIntegrationConfig.workspaceUrlKey,
  teamKey: linearIntegrationConfig.teamKey,
  projectUrl: linearIntegrationConfig.projectUrl,
};

type ConfigRow = {
  [K in keyof typeof configColumns]: string | null;
};

function labelsFromRow(row: ConfigRow | null | undefined): LinearLabelChoices {
  return {
    bug: choice(row?.bugLabelId, row?.bugLabelName),
    feature_request: choice(row?.featureLabelId, row?.featureLabelName),
    other: choice(row?.otherLabelId, row?.otherLabelName),
  };
}

// `sent` is what the admin submitted: `undefined` leaves the choice alone and
// `null` clears it. `keepSaved` is false once the team changes.
function nextChoice(
  saved: LinearChoice | null,
  sent: LinearChoice | null | undefined,
  keepSaved: boolean
): LinearChoice | null {
  if (sent !== undefined) {
    return sent;
  }
  return keepSaved ? saved : null;
}

// Both fields must be present and the secret must open. A saved secret that
// cannot be read counts as missing, the same as no secret at all.
function savedCredentials(
  row: { clientId: string | null; clientSecret: string | null } | null
): LinearCredentials | null {
  const clientId = row?.clientId?.trim();
  const clientSecret = readMaybeEncryptedSecret(row?.clientSecret ?? null);
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

async function loadRow() {
  const [row] = await db
    .select({
      ...configColumns,
      lastWebhookAt: linearIntegrationConfig.lastWebhookAt,
      lastWebhookRejectedAt: linearIntegrationConfig.lastWebhookRejectedAt,
      lastWebhookRejectionReason:
        linearIntegrationConfig.lastWebhookRejectionReason,
      webhookRejections: linearIntegrationConfig.webhookRejections,
      updatedAt: linearIntegrationConfig.updatedAt,
      ...lastUpdatedByColumns,
    })
    .from(linearIntegrationConfig)
    .leftJoin(users, eq(users.id, linearIntegrationConfig.updatedBy));
  return row ?? null;
}

export async function getLinearCredentials(): Promise<SavedLinearCredentials | null> {
  const row = await loadRow();
  const credentials = savedCredentials(row);
  if (!credentials) {
    return null;
  }
  return {
    ...credentials,
    webhookSecret: readMaybeEncryptedSecret(row?.webhookSecret ?? null),
  };
}

export interface LinearFeedbackSetup {
  clientId: string;
  clientSecret: string;
  labelIds: Record<FeedbackKind, string | null>;
  projectId: string | null;
  teamId: string;
}

// Feedback is on only when an admin has saved credentials and a team.
export async function getLinearFeedbackSetup(): Promise<LinearFeedbackSetup | null> {
  const row = await loadRow();
  const credentials = savedCredentials(row);
  const teamId = row?.teamId ?? null;
  if (!(credentials && teamId)) {
    return null;
  }
  return {
    ...credentials,
    teamId,
    projectId: row?.projectId ?? null,
    labelIds: {
      bug: row?.bugLabelId ?? null,
      feature_request: row?.featureLabelId ?? null,
      other: row?.otherLabelId ?? null,
    },
  };
}

export async function isFeedbackConfigured(): Promise<boolean> {
  return (await getLinearFeedbackSetup()) != null;
}

// `updated_at` is the time of the last admin save. Setting it to itself in the
// same update stops its `$onUpdate` hook from moving it on every delivery.
function rejectionReason(
  value: string | null | undefined
): LinearWebhookRejectionReason | null {
  if (value === "signature" || value === "stale") {
    return value;
  }
  return null;
}

// A valid delivery proves the signing secret. It counts as "working" only
// when the issue is in the saved team, because a webhook covers one team.
export async function recordLinearWebhookAccepted(input: {
  forSavedTeam: boolean;
}): Promise<void> {
  await db
    .update(linearIntegrationConfig)
    .set({
      webhookRejections: 0,
      lastWebhookRejectedAt: null,
      lastWebhookRejectionReason: null,
      ...(input.forSavedTeam ? { lastWebhookAt: new Date() } : {}),
      updatedAt: sql`${linearIntegrationConfig.updatedAt}`,
    })
    .where(eq(linearIntegrationConfig.id, true));
}

export async function recordLinearWebhookRejection(
  reason: LinearWebhookRejectionReason
): Promise<void> {
  await db
    .update(linearIntegrationConfig)
    .set({
      webhookRejections: sql`${linearIntegrationConfig.webhookRejections} + 1`,
      lastWebhookRejectedAt: new Date(),
      lastWebhookRejectionReason: reason,
      updatedAt: sql`${linearIntegrationConfig.updatedAt}`,
    })
    .where(eq(linearIntegrationConfig.id, true));
}

export interface LinearWebhookContext {
  credentials: SavedLinearCredentials;
  teamId: string | null;
  workspaceId: string | null;
}

export async function getLinearWebhookContext(): Promise<LinearWebhookContext | null> {
  const row = await loadRow();
  const credentials = savedCredentials(row);
  const webhookSecret = readMaybeEncryptedSecret(row?.webhookSecret ?? null);
  if (!(credentials && webhookSecret)) {
    return null;
  }
  return {
    credentials: { ...credentials, webhookSecret },
    teamId: row?.teamId ?? null,
    workspaceId: row?.workspaceId ?? null,
  };
}

// Fills in what a setup saved before this version never stored: the workspace
// name, the team key, and the project link. The page runs it in the
// background, so any failure (Linear down, network error) leaves the row
// alone and the next page load tries again.
export async function backfillLinearSetup(): Promise<void> {
  try {
    const row = await loadRow();
    const credentials = savedCredentials(row);
    if (!credentials) {
      return;
    }
    const missingWorkspace = !row?.workspaceId;
    const missingTeamKey = Boolean(row?.teamId && !row.teamKey);
    const missingProjectUrl = Boolean(row?.projectId && !row.projectUrl);
    if (!(missingWorkspace || missingTeamKey || missingProjectUrl)) {
      return;
    }

    const [organization, teams, options] = await Promise.all([
      missingWorkspace ? testLinearConnection(credentials) : null,
      missingTeamKey ? listLinearTeams(credentials) : null,
      missingProjectUrl && row?.teamId
        ? listLinearTeamOptions(credentials, row.teamId)
        : null,
    ]);
    const teamKey = teams?.find((team) => team.id === row?.teamId)?.key;
    const projectUrl = options?.projects.find(
      (project) => project.id === row?.projectId
    )?.url;

    // The write is skipped if an admin changed the team or project, or
    // connected a workspace, while Linear was answering.
    await db
      .update(linearIntegrationConfig)
      .set({
        ...(organization
          ? {
              workspaceId: organization.id,
              workspaceName: organization.name,
              workspaceUrlKey: organization.urlKey,
            }
          : {}),
        ...(teamKey ? { teamKey } : {}),
        ...(projectUrl ? { projectUrl } : {}),
        updatedAt: sql`${linearIntegrationConfig.updatedAt}`,
      })
      .where(
        and(
          eq(linearIntegrationConfig.id, true),
          row?.teamId
            ? eq(linearIntegrationConfig.teamId, row.teamId)
            : isNull(linearIntegrationConfig.teamId),
          row?.projectId
            ? eq(linearIntegrationConfig.projectId, row.projectId)
            : isNull(linearIntegrationConfig.projectId),
          missingWorkspace
            ? isNull(linearIntegrationConfig.workspaceId)
            : undefined
        )
      );
  } catch (err) {
    console.error("[linear] Could not fill in the saved setup:", err);
  }
}

export function linearFeedbackViewUrl(input: {
  projectUrl: string | null;
  teamKey: string | null;
  workspaceUrlKey: string | null;
}): string | null {
  if (input.projectUrl) {
    return input.projectUrl;
  }
  if (
    input.workspaceUrlKey &&
    input.teamKey &&
    /^[A-Za-z0-9_-]+$/.test(input.workspaceUrlKey) &&
    /^[A-Za-z0-9_-]+$/.test(input.teamKey)
  ) {
    return `https://linear.app/${input.workspaceUrlKey}/team/${input.teamKey}/all`;
  }
  return null;
}

// Returns false when this delivery id was seen before, so a resend by Linear
// does not notify the reporter twice. A delivery without an id cannot be
// told apart and always counts as new.
export async function claimLinearWebhookDelivery(
  deliveryId: string | null
): Promise<boolean> {
  if (!deliveryId) {
    return true;
  }
  const claimed = await db
    .insert(linearWebhookDeliveries)
    .values({ deliveryId })
    .onConflictDoNothing()
    .returning({ deliveryId: linearWebhookDeliveries.deliveryId });
  return claimed.length > 0;
}

export async function getLinearConfigForAdmin(): Promise<LinearConfigForAdmin> {
  const row = await loadRow();
  // No environment variable backs these, so `unreadable` means the saved
  // value cannot be opened and `set` is false.
  const savedSecret = (stored: string | null | undefined) =>
    secretFieldStatus(
      resolveIntegrationField(inspectSavedSecret(stored ?? null))
    );
  return {
    clientId: plainFieldStatus(
      resolveIntegrationField(savedPlainValue(row?.clientId ?? null))
    ),
    clientSecret: savedSecret(row?.clientSecret),
    webhookSecret: savedSecret(row?.webhookSecret),
    team: choice(row?.teamId, row?.teamName),
    teamKey: row?.teamKey ?? null,
    project: choice(row?.projectId, row?.projectName),
    projectUrl: row?.projectUrl ?? null,
    labels: labelsFromRow(row),
    workspaceId: row?.workspaceId ?? null,
    workspaceName: row?.workspaceName ?? null,
    workspaceUrlKey: row?.workspaceUrlKey ?? null,
    webhookRejections: row?.webhookRejections ?? 0,
    lastWebhookAt: row?.lastWebhookAt ?? null,
    lastWebhookRejectedAt: row?.lastWebhookRejectedAt ?? null,
    lastWebhookRejectionReason: rejectionReason(
      row?.lastWebhookRejectionReason
    ),
    lastUpdated: toLastUpdated(row),
  };
}

export async function updateLinearConfig(
  patch: LinearConfigPutBody,
  updatedBy: string
): Promise<LinearConfigForAdmin> {
  await db.transaction(async (tx) => {
    // Locks the singleton row so two admins saving at once apply one after
    // the other. The team change below is decided from the locked row, so
    // it cannot be based on a stale read.
    await tx
      .insert(linearIntegrationConfig)
      .values({ id: true, updatedBy })
      .onConflictDoNothing();
    const [row] = await tx
      .select(configColumns)
      .from(linearIntegrationConfig)
      .where(eq(linearIntegrationConfig.id, true))
      .for("update");

    const savedTeam = choice(row?.teamId, row?.teamName);
    const team = patch.team === undefined ? savedTeam : patch.team;
    // A project or label belongs to one team, so a team change drops saved
    // ones. Choices sent in the same save came from the new team's lists and
    // stay. With no team, nothing is kept.
    const keepSaved = team != null && team.id === savedTeam?.id;
    const pick = (
      saved: LinearChoice | null,
      sent: LinearChoice | null | undefined
    ) => (team == null ? null : nextChoice(saved, sent, keepSaved));

    const project = pick(
      choice(row?.projectId, row?.projectName),
      patch.project
    );
    const teamChanged = team?.id !== savedTeam?.id;
    const teamKey =
      team == null
        ? null
        : patch.team === undefined
          ? (row?.teamKey ?? null)
          : teamChanged
            ? (patch.team?.key ?? null)
            : (patch.team?.key ?? row?.teamKey ?? null);
    let projectUrl: string | null = null;
    if (project) {
      if (patch.project === undefined) {
        projectUrl = row?.projectUrl ?? null;
      } else if (patch.project?.url) {
        projectUrl = patch.project.url;
      } else if (patch.project?.id === row?.projectId) {
        projectUrl = row?.projectUrl ?? null;
      }
    }
    const savedLabels = labelsFromRow(row);
    const labels: LinearLabelChoices = {
      bug: pick(savedLabels.bug, patch.labels?.bug),
      feature_request: pick(
        savedLabels.feature_request,
        patch.labels?.feature_request
      ),
      other: pick(savedLabels.other, patch.labels?.other),
    };

    await tx
      .update(linearIntegrationConfig)
      .set({
        webhookSecret: nextSecret(
          row?.webhookSecret ?? null,
          patch.webhook_secret
        ),
        teamId: team?.id ?? null,
        teamName: team?.name ?? null,
        teamKey,
        projectId: project?.id ?? null,
        projectName: project?.name ?? null,
        projectUrl,
        bugLabelId: labels.bug?.id ?? null,
        bugLabelName: labels.bug?.name ?? null,
        featureLabelId: labels.feature_request?.id ?? null,
        featureLabelName: labels.feature_request?.name ?? null,
        otherLabelId: labels.other?.id ?? null,
        otherLabelName: labels.other?.name ?? null,
        ...(teamChanged ? { lastWebhookAt: null } : {}),
        ...(patch.webhook_secret === undefined
          ? {}
          : {
              webhookRejections: 0,
              lastWebhookRejectedAt: null,
              lastWebhookRejectionReason: null,
            }),
        updatedAt: new Date(),
        updatedBy,
      })
      .where(eq(linearIntegrationConfig.id, true));
  });

  return getLinearConfigForAdmin();
}

export async function connectLinearApp(input: {
  clientId: string;
  clientSecret: string;
  confirmWorkspaceChange: boolean;
  organization: LinearOrganization;
  updatedBy: string;
}): Promise<LinearConfigForAdmin> {
  await db.transaction(async (tx) => {
    await tx
      .insert(linearIntegrationConfig)
      .values({ id: true, updatedBy: input.updatedBy })
      .onConflictDoNothing();
    const [row] = await tx
      .select(configColumns)
      .from(linearIntegrationConfig)
      .where(eq(linearIntegrationConfig.id, true))
      .for("update");

    const workspaceChanged = Boolean(
      row?.workspaceId && row.workspaceId !== input.organization.id
    );
    if (workspaceChanged && !input.confirmWorkspaceChange) {
      throw new LinearWorkspaceChangeError(
        input.organization.id,
        input.organization.name
      );
    }

    await tx
      .update(linearIntegrationConfig)
      .set({
        clientId: input.clientId,
        clientSecret: nextSecret(row?.clientSecret ?? null, input.clientSecret),
        workspaceId: input.organization.id,
        workspaceName: input.organization.name,
        workspaceUrlKey: input.organization.urlKey,
        ...(workspaceChanged
          ? {
              webhookSecret: null,
              teamId: null,
              teamName: null,
              teamKey: null,
              projectId: null,
              projectName: null,
              projectUrl: null,
              bugLabelId: null,
              bugLabelName: null,
              featureLabelId: null,
              featureLabelName: null,
              otherLabelId: null,
              otherLabelName: null,
              lastWebhookAt: null,
              webhookRejections: 0,
              lastWebhookRejectedAt: null,
              lastWebhookRejectionReason: null,
            }
          : {}),
        updatedAt: new Date(),
        updatedBy: input.updatedBy,
      })
      .where(eq(linearIntegrationConfig.id, true));
  });

  clearLinearTokenCache();
  return getLinearConfigForAdmin();
}

export async function disconnectLinear(): Promise<void> {
  await db
    .delete(linearIntegrationConfig)
    .where(eq(linearIntegrationConfig.id, true));
  clearLinearTokenCache();
}
