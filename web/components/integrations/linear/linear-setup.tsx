"use client";

import { useRouter } from "next/navigation";
import { parseAsStringLiteral, useQueryState } from "nuqs";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { Card, CardContent } from "@/components/ui/card";
import { ConnectStep } from "./connect-step";
import { DestinationStep } from "./destination-step";
import {
  type ConnectFailure,
  type LinearOptions,
  type LinearSetupData,
  LinearSetupProvider,
  type LinearStep,
  type SetupChoice,
  type TestReportProgress,
  useLinearSetup,
} from "./linear-setup-context";
import { StatusUpdatesStep } from "./status-updates-step";
import { CompletedStep, CurrentStep, SetupSteps, UpcomingStep } from "./steps";
import { LinearSummary } from "./summary";
import { TestReportStep } from "./test-report-step";

const STEP_ORDER = ["connect", "destination", "updates", "test"] as const;

const STEP_COPY = {
  connect: {
    number: 1,
    title: "Connect your Linear app",
    description: "Data Hub signs in to Linear as an app to file reports.",
    upcoming: "Opens once the key is set.",
  },
  destination: {
    number: 2,
    title: "Choose where reports go",
    description: "Pick the team, project, and labels for new reports.",
    upcoming: "Pick the team, project, and labels for new reports.",
  },
  updates: {
    number: 3,
    title: "Get status updates from Linear",
    description: "When an issue closes, Data Hub tells the person who sent it.",
    upcoming: "When an issue closes, Data Hub tells the person who sent it.",
  },
  test: {
    number: 4,
    title: "Send a test report",
    description:
      "Check the whole path, from a new report to the message its sender gets.",
    upcoming:
      "Check the whole path, from a new report to the message its sender gets.",
  },
} as const;

const SETTINGS = "/api/v1/settings/integrations/linear";

interface ConfigPayload {
  client_id: { set: boolean; value: string | null };
  client_secret: { set: boolean };
  labels: LinearSetupData["labels"];
  last_webhook_at: string | null;
  last_webhook_rejection_reason: "signature" | "stale" | null;
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

function applyPayload(
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

async function readPayload(res: Response): Promise<ConfigPayload> {
  const payload = (await res.json().catch(() => null)) as {
    error?: {
      code?: string;
      details?: { workspace_name?: string };
      message?: string;
    };
  } & Partial<ConfigPayload>;
  if (!(res.ok && payload?.client_id)) {
    const error = new Error(
      payload?.error?.message ?? "Couldn't save Linear settings"
    ) as Error & {
      code?: string;
      workspaceName?: string;
    };
    error.code = payload?.error?.code;
    error.workspaceName = payload?.error?.details?.workspace_name;
    throw error;
  }
  return payload as ConfigPayload;
}

function resolveStep(
  data: LinearSetupData,
  requested: LinearStep | null
): LinearStep | "blocked" | "summary" {
  if (data.keyStatus !== "ok") {
    return "blocked";
  }
  if (!data.clientSecretSet) {
    return "connect";
  }
  if (!data.team) {
    return requested === "connect" ? "connect" : "destination";
  }
  return requested ?? "summary";
}

export function LinearSetup({ initial }: { initial: LinearSetupData }) {
  const router = useRouter();
  const [data, setData] = useState(initial);
  const [requested, setRequested] = useQueryState(
    "linear_step",
    parseAsStringLiteral(STEP_ORDER).withOptions({
      history: "replace",
      shallow: true,
    })
  );

  useEffect(() => {
    setData(initial);
  }, [initial]);

  const step = resolveStep(data, requested);

  const refresh = useCallback(async () => {
    const res = await fetch(SETTINGS);
    if (!res.ok) {
      return;
    }
    const payload = (await res.json()) as ConfigPayload;
    setData((current) => applyPayload(payload, current));
  }, []);

  const goTo = useCallback(
    (next: LinearStep | null) => {
      void setRequested(next);
    },
    [setRequested]
  );

  const connect = useCallback(
    async (input: {
      clientId: string;
      clientSecret: string;
      confirmWorkspaceChange?: boolean;
    }): Promise<ConnectFailure | null> => {
      const res = await fetch(`${SETTINGS}/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: input.clientId.trim(),
          client_secret: input.clientSecret.trim(),
          confirm_workspace_change: input.confirmWorkspaceChange === true,
        }),
      });
      try {
        const payload = await readPayload(res);
        setData((current) => applyPayload(payload, current));
        void setRequested("destination");
        router.refresh();
        return null;
      } catch (err) {
        const failure = err as Error & {
          code?: string;
          workspaceName?: string;
        };
        return {
          code: failure.code ?? "ERROR",
          message: failure.message,
          workspaceName: failure.workspaceName,
        };
      }
    },
    [router, setRequested]
  );

  const save = useCallback(
    async (body: Record<string, unknown>) => {
      const res = await fetch(SETTINGS, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await readPayload(res);
      setData((current) => applyPayload(payload, current));
      router.refresh();
    },
    [router]
  );

  const value = useMemo(
    () => ({
      connect,
      data,
      disconnect: async () => {
        const res = await fetch(SETTINGS, { method: "DELETE" });
        const payload = await readPayload(res);
        setData((current) => applyPayload(payload, current));
        void setRequested(null);
        router.refresh();
      },
      goTo,
      loadOptions: async (teamId: string | null): Promise<LinearOptions> => {
        const query = teamId ? `?team_id=${encodeURIComponent(teamId)}` : "";
        const res = await fetch(`${SETTINGS}/options${query}`);
        const payload = (await res.json().catch(() => null)) as {
          error?: { message?: string };
          labels?: SetupChoice[] | null;
          projects?: SetupChoice[] | null;
          teams?: SetupChoice[];
        } | null;
        if (!(res.ok && payload?.teams)) {
          throw new Error(
            payload?.error?.message ?? "Couldn't load teams from Linear"
          );
        }
        return {
          teams: payload.teams,
          projects: payload.projects ?? [],
          labels: payload.labels ?? [],
        };
      },
      refresh,
      saveDestination: (input: {
        labels: LinearSetupData["labels"];
        project: SetupChoice | null;
        team: SetupChoice | null;
      }) =>
        save({
          team: input.team,
          project: input.project,
          labels: input.labels,
        }),
      saveSigningSecret: (secret: string) => save({ webhook_secret: secret }),
      sendTestReport: async () => {
        const res = await fetch(`${SETTINGS}/test-report`, { method: "POST" });
        const payload = (await res.json().catch(() => null)) as {
          error?: { message?: string };
          feedback?: {
            id: string;
            linear_issue: {
              identifier: string;
              labels: { name: string }[];
              team_name: string;
              url: string;
            };
          };
        } | null;
        const issue = payload?.feedback;
        if (!(res.ok && issue)) {
          throw new Error(
            payload?.error?.message ?? "Couldn't send the test report"
          );
        }
        return {
          id: issue.id,
          identifier: issue.linear_issue.identifier,
          url: issue.linear_issue.url,
          teamName: issue.linear_issue.team_name,
          labelName: issue.linear_issue.labels[0]?.name ?? null,
        };
      },
      step,
      testReport: async (id: string): Promise<TestReportProgress> => {
        const res = await fetch(
          `${SETTINGS}/test-report/${encodeURIComponent(id)}`
        );
        const payload = (await res.json().catch(() => null)) as {
          closed?: boolean;
          error?: { message?: string };
          identifier?: string;
          label_name?: string | null;
          last_webhook_rejection_reason?: "signature" | "stale" | null;
          notification_at?: string | null;
          notifications_enabled?: boolean;
          state_name?: string;
          team_name?: string;
          update_received?: boolean;
          url?: string;
          webhook_rejections?: number;
        } | null;
        if (!(res.ok && payload?.identifier && payload.url)) {
          throw new Error(payload?.error?.message ?? "Couldn't check the test");
        }
        return {
          closed: payload.closed === true,
          identifier: payload.identifier,
          labelName: payload.label_name ?? null,
          notificationAt: payload.notification_at ?? null,
          notificationsEnabled: payload.notifications_enabled !== false,
          rejectionReason: payload.last_webhook_rejection_reason ?? null,
          rejections: payload.webhook_rejections ?? 0,
          stateName: payload.state_name ?? "",
          teamName: payload.team_name ?? "",
          updateReceived: payload.update_received === true,
          url: payload.url,
        };
      },
    }),
    [connect, data, goTo, refresh, router, save, setRequested, step]
  );

  return (
    <LinearSetupProvider value={value}>
      <section className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-semibold text-lg tracking-tight">Linear</h2>
            <p className="text-muted-foreground text-sm">
              Bugs and requests people send from Data Hub become issues in
              Linear.
            </p>
          </div>
          <ConnectionBadge data={data} />
        </div>
        <Card>
          <CardContent>
            {step === "blocked" ? (
              <BlockedSetup />
            ) : step === "summary" ? (
              <LinearSummary />
            ) : (
              <Wizard current={step} />
            )}
          </CardContent>
        </Card>
      </section>
    </LinearSetupProvider>
  );
}

function ConnectionBadge({ data }: { data: LinearSetupData }) {
  if (data.keyStatus !== "ok" || !data.clientSecretSet) {
    return <Badge tone="muted">Not connected</Badge>;
  }
  if (data.webhookRejections > 0) {
    return <Badge tone="attention">Needs attention</Badge>;
  }
  return (
    <Badge tone="ok">
      {data.workspaceName ? `Connected · ${data.workspaceName}` : "Connected"}
    </Badge>
  );
}

function Badge({
  children,
  tone,
}: {
  children: string;
  tone: "attention" | "muted" | "ok";
}) {
  const toneClass = {
    attention:
      "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100",
    muted: "bg-muted text-muted-foreground",
    ok: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200",
  }[tone];
  return (
    <span
      className={`rounded-full px-2.5 py-1 font-medium text-xs ${toneClass}`}
    >
      {children}
    </span>
  );
}

function BlockedSetup() {
  const { data } = useLinearSetup();
  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-950 text-sm dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
        <p className="font-medium">Data Hub can't store Linear secrets yet</p>
        <p className="mt-1">
          This deployment has no usable{" "}
          <span className="font-mono">INTEGRATION_SECRETS_KEY</span>, which Data
          Hub needs to encrypt the client secret. Ask a developer to add it in
          Vercel and redeploy. This command makes one:
        </p>
        <div className="mt-2 flex gap-2">
          <code className="flex h-8 flex-1 items-center rounded-md border bg-background px-2 font-mono text-xs">
            openssl rand -hex 32
          </code>
          <CopyButton size="icon-sm" value="openssl rand -hex 32" />
        </div>
      </div>
      <SetupSteps>
        {STEP_ORDER.map((id) => (
          <UpcomingStep
            description={
              id === "connect" && data.keyStatus !== "ok"
                ? STEP_COPY.connect.upcoming
                : STEP_COPY[id].description
            }
            key={id}
            number={STEP_COPY[id].number}
            title={STEP_COPY[id].title}
          />
        ))}
      </SetupSteps>
    </div>
  );
}

function Wizard({ current }: { current: LinearStep }) {
  const { data, goTo } = useLinearSetup();
  const currentIndex = STEP_ORDER.indexOf(current);
  return (
    <SetupSteps>
      {STEP_ORDER.map((id) => {
        const copy = STEP_COPY[id];
        const index = STEP_ORDER.indexOf(id);
        if (index < currentIndex && isDone(id, data)) {
          return (
            <CompletedStep
              detail={completedDetail(id, data)}
              key={id}
              onChange={() => goTo(id)}
              title={copy.title}
            />
          );
        }
        if (id === current) {
          return (
            <CurrentStep
              description={copy.description}
              key={id}
              number={copy.number}
              title={copy.title}
            >
              <StepBody id={id} />
            </CurrentStep>
          );
        }
        return (
          <UpcomingStep
            description={copy.description}
            key={id}
            number={copy.number}
            title={copy.title}
          />
        );
      })}
    </SetupSteps>
  );
}

function StepBody({ id }: { id: LinearStep }) {
  if (id === "connect") {
    return <ConnectStep />;
  }
  if (id === "destination") {
    return <DestinationStep />;
  }
  if (id === "updates") {
    return <StatusUpdatesStep />;
  }
  return <TestReportStep />;
}

function isDone(id: LinearStep, data: LinearSetupData): boolean {
  if (id === "connect") {
    return data.clientSecretSet;
  }
  if (id === "destination") {
    return data.team !== null;
  }
  if (id === "updates") {
    return data.webhookSecretSet;
  }
  return false;
}

function completedDetail(id: LinearStep, data: LinearSetupData): string {
  if (id === "connect") {
    return `Connected to ${data.workspaceName ?? "Linear"}.`;
  }
  if (id === "destination") {
    const project = data.project ? `, ${data.project.name} project` : "";
    return `${data.team?.name ?? "Team"} team${project}. Feedback is on.`;
  }
  if (data.lastWebhookAt) {
    return "Working. Linear's first update has arrived.";
  }
  return "Waiting for Linear's first update.";
}
