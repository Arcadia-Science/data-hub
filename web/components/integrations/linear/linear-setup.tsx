"use client";

import { TriangleAlertIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { parseAsStringLiteral, useQueryState } from "nuqs";
import { type ComponentType, useCallback, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTimeShort } from "@/lib/date";
import { cn } from "@/lib/utils";
import { ConnectStep } from "./connect-step";
import { DestinationStep } from "./destination-step";
import {
  applyPayload,
  fetchConfig,
  requestConnect,
  requestDisconnect,
  requestOptions,
  requestSave,
  requestTestReport,
  requestTestReportProgress,
  SetupRequestError,
} from "./linear-setup-api";
import {
  type ConnectFailure,
  type LinearSetupActions,
  type LinearSetupData,
  LinearSetupProvider,
  type LinearSetupState,
  type LinearStep,
  useLinearSetup,
} from "./linear-setup-context";
import { StatusUpdatesStep } from "./status-updates-step";
import {
  CompletedStep,
  CopyValue,
  CurrentStep,
  SetupSteps,
  UpcomingStep,
} from "./steps";
import { LinearSummary } from "./summary";
import { TestReportStep } from "./test-report-step";

interface StepDefinition {
  Body: ComponentType;
  description: string;
  // What the completed row says once the admin has moved past this step.
  doneDetail: (data: LinearSetupData) => string;
  isDone: (data: LinearSetupData) => boolean;
  number: number;
  title: string;
}

const STEPS: Record<LinearStep, StepDefinition> = {
  connect: {
    number: 1,
    title: "Connect your Linear app",
    description: "Data Hub signs in to Linear as an app to file reports.",
    Body: ConnectStep,
    isDone: (data) => data.clientSecretSet,
    doneDetail: (data) => `Connected to ${data.workspaceName ?? "Linear"}.`,
  },
  destination: {
    number: 2,
    title: "Choose where reports go",
    description: "Pick the team, project, and labels for new reports.",
    Body: DestinationStep,
    isDone: (data) => data.team !== null,
    doneDetail: (data) => {
      const project = data.project ? `, ${data.project.name} project` : "";
      return `${data.team?.name ?? "Team"} team${project}. Feedback is on.`;
    },
  },
  updates: {
    number: 3,
    title: "Get status updates from Linear",
    description: "When an issue closes, Data Hub tells the person who sent it.",
    Body: StatusUpdatesStep,
    isDone: (data) => data.webhookSecretSet,
    doneDetail: (data) =>
      data.lastWebhookAt
        ? `Working. Linear's last update arrived ${formatDateTimeShort(new Date(data.lastWebhookAt))}.`
        : "Waiting for an update from Linear.",
  },
  test: {
    number: 4,
    title: "Send a test report",
    description:
      "Check the whole path, from a new report to the message its sender gets.",
    Body: TestReportStep,
    isDone: () => false,
    doneDetail: () => "",
  },
};

const STEP_ORDER = ["connect", "destination", "updates", "test"] as const;

function resolveStep(
  data: LinearSetupData,
  requested: LinearStep | null
): LinearSetupState["step"] {
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

// `initial` seeds the state once. The page remounts this component (through a
// `key`) after every admin save, so it never needs to copy new props in.
export function LinearSetup({ initial }: { initial: LinearSetupData }) {
  const router = useRouter();
  const [data, setData] = useState(initial);
  const [moved, setMoved] = useState(false);
  const [requested, setRequested] = useQueryState(
    "linear_step",
    parseAsStringLiteral(STEP_ORDER).withOptions({
      history: "replace",
      shallow: true,
    })
  );

  const goTo = useCallback(
    (next: LinearStep | null) => {
      setMoved(true);
      void setRequested(next);
    },
    [setRequested]
  );

  const refresh = useCallback(async () => {
    try {
      const payload = await fetchConfig();
      setData((current) => applyPayload(payload, current));
    } catch {
      // Polling asks again on the next tick.
    }
  }, []);

  const connect = useCallback(
    async (input: {
      clientId: string;
      clientSecret: string;
      confirmWorkspaceChange?: boolean;
    }): Promise<ConnectFailure | null> => {
      try {
        const payload = await requestConnect({
          ...input,
          confirmWorkspaceChange: input.confirmWorkspaceChange === true,
        });
        setData((current) => applyPayload(payload, current));
        goTo("destination");
        router.refresh();
        return null;
      } catch (err) {
        const request = err instanceof SetupRequestError ? err : null;
        return {
          code: request?.code ?? "ERROR",
          message:
            err instanceof Error
              ? err.message
              : "Couldn't save Linear settings",
          workspaceName: request?.workspaceName,
        };
      }
    },
    [goTo, router]
  );

  const save = useCallback(
    async (body: Record<string, unknown>) => {
      const payload = await requestSave(body);
      setData((current) => applyPayload(payload, current));
      router.refresh();
    },
    [router]
  );

  const disconnect = useCallback(async () => {
    const payload = await requestDisconnect();
    setData((current) => applyPayload(payload, current));
    goTo(null);
    router.refresh();
  }, [goTo, router]);

  const actions = useMemo<LinearSetupActions>(
    () => ({
      connect,
      disconnect,
      goTo,
      loadOptions: requestOptions,
      refresh,
      saveDestination: (input) =>
        save({
          team: input.team,
          project: input.project,
          labels: input.labels,
        }),
      saveSigningSecret: (secret: string) => save({ webhook_secret: secret }),
      sendTestReport: requestTestReport,
      testReport: requestTestReportProgress,
    }),
    [connect, disconnect, goTo, refresh, save]
  );

  const step = resolveStep(data, requested);
  const state = useMemo(() => ({ data, moved, step }), [data, moved, step]);

  return (
    <LinearSetupProvider actions={actions} state={state}>
      <section className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-semibold text-lg tracking-tight">Linear</h2>
            <p className="text-pretty text-muted-foreground text-sm">
              Bugs and requests people send from Data Hub become issues in
              Linear.
            </p>
          </div>
          <ConnectionBadge data={data} />
        </div>
        <Card className="gap-0 py-0">
          <CardContent className="px-0">
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

const BADGE_TONE = {
  attention:
    "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100",
  muted: "",
  ok: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200",
} as const;

function ConnectionBadge({ data }: { data: LinearSetupData }) {
  if (data.keyStatus !== "ok" || !data.clientSecretSet) {
    return <StatusBadge tone="muted">Not connected</StatusBadge>;
  }
  if (data.webhookRejections > 0) {
    return <StatusBadge tone="attention">Needs attention</StatusBadge>;
  }
  return (
    <StatusBadge tone="ok">
      {data.workspaceName ? `Connected · ${data.workspaceName}` : "Connected"}
    </StatusBadge>
  );
}

// The workspace name is the admin's own text, so the badge truncates it
// instead of pushing the header apart.
function StatusBadge({
  children,
  tone,
}: {
  children: string;
  tone: keyof typeof BADGE_TONE;
}) {
  return (
    <div className="flex min-w-0 max-w-[50%] shrink-0 justify-end">
      <Badge
        className={cn("max-w-full", BADGE_TONE[tone])}
        variant={tone === "muted" ? "secondary" : "default"}
      >
        <span className="truncate">{children}</span>
      </Badge>
    </div>
  );
}

function BlockedSetup() {
  return (
    <div>
      <div
        className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-3 border-amber-200 border-b bg-amber-50 px-6 py-4 text-amber-950 text-sm dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100"
        role="alert"
      >
        <TriangleAlertIcon
          aria-hidden="true"
          className="mt-0.5 size-5 text-amber-600 dark:text-amber-400"
        />
        <div className="flex min-w-0 flex-col gap-1">
          <p className="font-semibold">
            Data Hub can't store Linear secrets yet
          </p>
          <p className="text-pretty">
            This deployment has no usable{" "}
            <code
              className="rounded bg-amber-100 px-1 font-mono text-[13px] dark:bg-amber-900"
              translate="no"
            >
              INTEGRATION_SECRETS_KEY
            </code>
            , which Data Hub needs to encrypt the client secret. Ask a developer
            to add it in Vercel and redeploy. This command makes one:
          </p>
          <CopyValue
            label="Command that makes the key"
            value="openssl rand -hex 32"
          />
        </div>
      </div>
      <SetupSteps>
        {STEP_ORDER.map((id) => (
          <UpcomingStep
            description={
              id === "connect"
                ? "Opens once the key is set."
                : STEPS[id].description
            }
            key={id}
            number={STEPS[id].number}
            title={STEPS[id].title}
          />
        ))}
      </SetupSteps>
    </div>
  );
}

function Wizard({ current }: { current: LinearStep }) {
  const { actions, state } = useLinearSetup();
  const currentIndex = STEP_ORDER.indexOf(current);
  return (
    <SetupSteps>
      {STEP_ORDER.map((id, index) => {
        const step = STEPS[id];
        if (index < currentIndex && step.isDone(state.data)) {
          return (
            <CompletedStep
              detail={step.doneDetail(state.data)}
              key={id}
              onChange={() => actions.goTo(id)}
              title={step.title}
            />
          );
        }
        if (id === current) {
          return (
            <CurrentStep
              description={step.description}
              focusHeading={state.moved}
              key={id}
              number={step.number}
              title={step.title}
            >
              <step.Body />
            </CurrentStep>
          );
        }
        return (
          <UpcomingStep
            description={step.description}
            key={id}
            number={step.number}
            title={step.title}
          />
        );
      })}
    </SetupSteps>
  );
}
