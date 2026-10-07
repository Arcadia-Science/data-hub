// The requests the Linear setup makes. The provider calls these and keeps the
// results in state, so the step components never call `fetch` themselves.

import type { LinearWebhookRejectionReason } from "@/lib/linear/webhook";
import type {
  LinearOptions,
  LinearSetupData,
  SentTestReport,
  SetupChoice,
  SetupLabels,
  TestReportProgress,
} from "./linear-setup-context";

const SETTINGS = "/api/v1/settings/integrations/linear";

interface ErrorBody {
  error?: {
    code?: string;
    details?: { workspace_name?: string };
    message?: string;
  };
}

// Carries the API's error code, so the connect step can tell "client
// credentials are off" and "different workspace" apart from other failures.
export class SetupRequestError extends Error {
  readonly code: string | undefined;
  readonly workspaceName: string | undefined;

  constructor(body: ErrorBody | null, fallback: string) {
    super(body?.error?.message ?? fallback);
    this.name = "SetupRequestError";
    this.code = body?.error?.code;
    this.workspaceName = body?.error?.details?.workspace_name;
  }
}

interface ConfigPayload {
  client_id: { set: boolean; value: string | null };
  client_secret: { set: boolean };
  labels: SetupLabels;
  last_webhook_at: string | null;
  last_webhook_rejection_reason: LinearWebhookRejectionReason | null;
  project: SetupChoice | null;
  secrets_key: LinearSetupData["keyStatus"];
  team: SetupChoice | null;
  team_key: string | null;
  updated_at: string | null;
  updated_by: { name: string | null } | null;
  webhook_rejections: number;
  webhook_secret: { set: boolean };
  workspace_name: string | null;
}

async function readJson<T>(res: Response): Promise<(ErrorBody & T) | null> {
  return (await res.json().catch(() => null)) as (ErrorBody & T) | null;
}

export function applyPayload(
  payload: ConfigPayload,
  previous: LinearSetupData
): LinearSetupData {
  return {
    ...previous,
    clientId: payload.client_id.value,
    clientSecretSet: payload.client_secret.set,
    keyStatus: payload.secrets_key,
    labels: payload.labels,
    lastUpdatedAt: payload.updated_at,
    lastUpdatedBy: payload.updated_by?.name ?? null,
    lastWebhookAt: payload.last_webhook_at,
    project: payload.project,
    rejectionReason: payload.last_webhook_rejection_reason,
    team: payload.team
      ? { ...payload.team, key: payload.team_key ?? payload.team.key }
      : null,
    webhookRejections: payload.webhook_rejections,
    webhookSecretSet: payload.webhook_secret.set,
    workspaceName: payload.workspace_name,
  };
}

async function configRequest(
  path: string,
  init: RequestInit | undefined,
  fallback: string
): Promise<ConfigPayload> {
  const res = await fetch(`${SETTINGS}${path}`, init);
  const body = await readJson<Partial<ConfigPayload>>(res);
  if (!(res.ok && body?.client_id)) {
    throw new SetupRequestError(body, fallback);
  }
  return body as ConfigPayload;
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export function fetchConfig(): Promise<ConfigPayload> {
  return configRequest("", undefined, "Couldn't load Linear settings");
}

export function requestConnect(input: {
  clientId: string;
  clientSecret: string;
  confirmWorkspaceChange: boolean;
}): Promise<ConfigPayload> {
  return configRequest(
    "/connect",
    jsonInit("POST", {
      client_id: input.clientId.trim(),
      client_secret: input.clientSecret.trim(),
      confirm_workspace_change: input.confirmWorkspaceChange,
    }),
    "Couldn't save Linear settings"
  );
}

export function requestSave(
  body: Record<string, unknown>
): Promise<ConfigPayload> {
  return configRequest(
    "",
    jsonInit("PUT", body),
    "Couldn't save Linear settings"
  );
}

export function requestDisconnect(): Promise<ConfigPayload> {
  return configRequest(
    "",
    { method: "DELETE" },
    "Couldn't disconnect from Linear"
  );
}

export async function requestOptions(
  teamId: string | null
): Promise<LinearOptions> {
  const query = teamId ? `?team_id=${encodeURIComponent(teamId)}` : "";
  const res = await fetch(`${SETTINGS}/options${query}`);
  const body = await readJson<{
    labels?: SetupChoice[] | null;
    projects?: SetupChoice[] | null;
    teams?: SetupChoice[];
  }>(res);
  if (!(res.ok && body?.teams)) {
    throw new SetupRequestError(body, "Couldn't load teams from Linear");
  }
  return {
    teams: body.teams,
    projects: body.projects ?? [],
    labels: body.labels ?? [],
  };
}

export async function requestTestReport(): Promise<SentTestReport> {
  const res = await fetch(`${SETTINGS}/test-report`, { method: "POST" });
  const body = await readJson<{
    feedback?: {
      id: string;
      linear_issue: {
        identifier: string;
        labels: { name: string }[];
        team_name: string;
        url: string;
      };
    };
  }>(res);
  const issue = body?.feedback;
  if (!(res.ok && issue)) {
    throw new SetupRequestError(body, "Couldn't send the test report");
  }
  return {
    id: issue.id,
    identifier: issue.linear_issue.identifier,
    url: issue.linear_issue.url,
    teamName: issue.linear_issue.team_name,
    labelName: issue.linear_issue.labels[0]?.name ?? null,
  };
}

export async function requestTestReportProgress(
  id: string
): Promise<TestReportProgress> {
  const res = await fetch(`${SETTINGS}/test-report/${encodeURIComponent(id)}`);
  const body = await readJson<{
    closed?: boolean;
    identifier?: string;
    label_name?: string | null;
    last_webhook_rejection_reason?: LinearWebhookRejectionReason | null;
    notification_at?: string | null;
    notifications_enabled?: boolean;
    state_name?: string;
    team_name?: string;
    update_received?: boolean;
    url?: string;
    webhook_rejections?: number;
  }>(res);
  if (!(res.ok && body?.identifier && body.url)) {
    throw new SetupRequestError(body, "Couldn't check the test");
  }
  return {
    closed: body.closed === true,
    identifier: body.identifier,
    labelName: body.label_name ?? null,
    notificationAt: body.notification_at ?? null,
    notificationsEnabled: body.notifications_enabled !== false,
    rejectionReason: body.last_webhook_rejection_reason ?? null,
    rejections: body.webhook_rejections ?? 0,
    stateName: body.state_name ?? "",
    teamName: body.team_name ?? "",
    updateReceived: body.update_received === true,
    url: body.url,
  };
}
