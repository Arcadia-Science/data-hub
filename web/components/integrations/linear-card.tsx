"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { IntegrationField } from "@/components/integrations/integration-field";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  FEEDBACK_KIND_LABELS,
  feedbackKindSchema,
} from "@/lib/api/feedback-schema";
import type { LinearChoice, LinearOptionsResponse } from "@/lib/linear/client";
import type {
  LinearConfigForAdmin,
  LinearConfigPutBody,
  LinearLabelChoices,
} from "@/lib/linear/config";

type Props = Pick<
  LinearConfigForAdmin,
  "clientId" | "clientSecret" | "labels" | "project" | "team" | "webhookSecret"
>;

interface Options {
  labels: LinearChoice[];
  projects: LinearChoice[];
  teams: LinearChoice[];
}

// Radix Select reserves the empty string, so "no choice" needs its own value.
const NO_CHOICE = "__none__";

const NO_LABELS: LinearLabelChoices = {
  bug: null,
  feature_request: null,
  other: null,
};

async function fetchOptions(
  teamId: string | null,
  signal: AbortSignal
): Promise<Options> {
  const query = teamId ? `?team_id=${encodeURIComponent(teamId)}` : "";
  const res = await fetch(
    `/api/v1/settings/integrations/linear/options${query}`,
    { signal }
  );
  const payload = (await res.json().catch(() => null)) as
    | (Partial<LinearOptionsResponse> & { error?: { message?: string } })
    | null;
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
}

/**
 * Drafts live in state seeded from props, so the page renders this card with
 * a `key` that changes on every save. That remounts it with fresh drafts and
 * avoids copying props into state in an effect.
 */
export function LinearCard({
  clientId,
  clientSecret,
  labels: savedLabels,
  project: savedProject,
  team: savedTeam,
  webhookSecret,
}: Props) {
  const router = useRouter();
  const [clientIdDraft, setClientIdDraft] = useState(clientId.value ?? "");
  const [clientSecretDraft, setClientSecretDraft] = useState("");
  const [webhookSecretDraft, setWebhookSecretDraft] = useState("");
  const [team, setTeam] = useState(savedTeam);
  const [project, setProject] = useState(savedProject);
  const [labels, setLabels] = useState(savedLabels);
  const [options, setOptions] = useState<Options>({
    teams: [],
    projects: [],
    labels: [],
  });
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (!clientSecret.set) {
      return;
    }
    const controller = new AbortController();
    setLoadingOptions(true);
    setOptionsError(null);
    fetchOptions(team?.id ?? null, controller.signal)
      .then(setOptions)
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          setOptionsError(
            err instanceof Error ? err.message : "Couldn't load from Linear"
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoadingOptions(false);
        }
      });
    return () => controller.abort();
  }, [clientSecret.set, team?.id]);

  function handleTeamChange(next: LinearChoice | null) {
    // Projects belong to one team. Dropping them here means anything chosen
    // afterwards comes from the new team's lists and is saved with the team.
    if (next?.id === savedTeam?.id) {
      setProject(savedProject);
      setLabels(savedLabels);
    } else if (next?.id !== team?.id) {
      setProject(null);
      setLabels(NO_LABELS);
    }
    setTeam(next);
  }

  function buildPatch(): LinearConfigPutBody {
    const patch: LinearConfigPutBody = {};
    const nextClientId = clientIdDraft.trim();
    if (nextClientId !== (clientId.value ?? "")) {
      patch.client_id = nextClientId || null;
    }
    if (clientSecretDraft.trim()) {
      patch.client_secret = clientSecretDraft.trim();
    }
    if (webhookSecretDraft.trim()) {
      patch.webhook_secret = webhookSecretDraft.trim();
    }

    // After a team change the server drops saved choices that are not in the
    // request, so send every choice rather than only the edited ones.
    const teamChanged = team?.id !== savedTeam?.id;
    if (teamChanged) {
      patch.team = team;
    }
    if (teamChanged || project?.id !== savedProject?.id) {
      patch.project = project;
    }
    const changedLabels: Partial<LinearLabelChoices> = {};
    for (const kind of feedbackKindSchema.options) {
      if (teamChanged || labels[kind]?.id !== savedLabels[kind]?.id) {
        changedLabels[kind] = labels[kind];
      }
    }
    if (Object.keys(changedLabels).length > 0) {
      patch.labels = changedLabels;
    }
    return patch;
  }

  async function handleTest() {
    const body: { client_id?: string; client_secret?: string } = {};
    if (clientSecretDraft.trim()) {
      if (!clientIdDraft.trim()) {
        toast.error("Enter the client ID along with the client secret.");
        return;
      }
      body.client_id = clientIdDraft.trim();
      body.client_secret = clientSecretDraft.trim();
    }
    setTesting(true);
    try {
      const res = await fetch("/api/v1/settings/integrations/linear/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await res.json().catch(() => null)) as {
        error?: { message?: string };
        organization_name?: string;
      } | null;
      if (!res.ok) {
        toast.error(payload?.error?.message ?? "Couldn't reach Linear");
        return;
      }
      toast.success(`Connected to ${payload?.organization_name ?? "Linear"}`);
    } catch {
      toast.error("Couldn't reach Linear");
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    const patch = buildPatch();
    if (Object.keys(patch).length === 0) {
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/v1/settings/integrations/linear", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const payload = (await res.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      if (!res.ok) {
        toast.error(payload?.error?.message ?? "Couldn't save Linear settings");
        return;
      }
      toast.success("Linear settings saved");
      router.refresh();
    } catch {
      toast.error("Couldn't save Linear settings");
    } finally {
      setSaving(false);
    }
  }

  const choicesDisabled = !clientSecret.set || loadingOptions;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="font-semibold text-lg tracking-tight">Linear</h2>
        <p className="text-muted-foreground text-sm">
          The Linear app that will receive feedback reports. Create an OAuth app
          in Linear with client credentials turned on, then paste its client ID
          and secret here.
        </p>
      </div>
      <Card>
        <CardContent className="flex flex-col gap-6">
          <FieldGroup>
            <IntegrationField
              description="From the Linear app's settings."
              id="linear-client-id"
              label="Client ID"
              onChange={setClientIdDraft}
              status={clientId}
              type="text"
              value={clientIdDraft}
            />
            <IntegrationField
              description="From the Linear app's settings."
              id="linear-client-secret"
              label="Client secret"
              onChange={setClientSecretDraft}
              placeholder="Paste the client secret"
              status={clientSecret}
              type="password"
              value={clientSecretDraft}
            />
            <IntegrationField
              description="From the webhook's page in Linear. Data Hub uses it later to check that status updates really came from Linear."
              id="linear-webhook-secret"
              label="Webhook signing secret"
              onChange={setWebhookSecretDraft}
              placeholder="Paste the signing secret"
              status={webhookSecret}
              type="password"
              value={webhookSecretDraft}
            />
            <ChoiceSelect
              description="Only public teams are listed. Data Hub signs in as the app, which can't see private teams."
              disabled={choicesDisabled}
              emptyLabel="No team"
              id="linear-team"
              label="Team"
              onChange={handleTeamChange}
              options={options.teams}
              value={team}
            />
            {optionsError ? <FieldError>{optionsError}</FieldError> : null}
            <ChoiceSelect
              disabled={choicesDisabled || !team}
              emptyLabel="No project"
              id="linear-project"
              label="Project"
              onChange={setProject}
              options={options.projects}
              value={project}
            />
            {feedbackKindSchema.options.map((kind) => (
              <ChoiceSelect
                disabled={choicesDisabled || !team}
                emptyLabel="No label"
                id={`linear-label-${kind}`}
                key={kind}
                label={`${FEEDBACK_KIND_LABELS[kind]} label`}
                onChange={(choice) =>
                  setLabels((current) => ({ ...current, [kind]: choice }))
                }
                options={options.labels}
                value={labels[kind]}
              />
            ))}
          </FieldGroup>
          <div className="flex justify-end gap-2 border-t pt-4">
            <Button
              disabled={testing}
              onClick={handleTest}
              type="button"
              variant="outline"
            >
              {testing ? (
                <Loader2 className="animate-spin" data-icon="inline-start" />
              ) : null}
              Test connection
            </Button>
            <Button
              disabled={saving || loadingOptions}
              onClick={handleSave}
              type="button"
            >
              {saving ? (
                <Loader2 className="animate-spin" data-icon="inline-start" />
              ) : null}
              Save
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// The saved choice stays in the list while the options load, so the select
// can show its name before Linear answers.
function withCurrent(
  options: LinearChoice[],
  current: LinearChoice | null
): LinearChoice[] {
  if (!current || options.some((option) => option.id === current.id)) {
    return options;
  }
  return [current, ...options];
}

function ChoiceSelect({
  description,
  disabled,
  emptyLabel,
  id,
  label,
  onChange,
  options,
  value,
}: {
  description?: string;
  disabled: boolean;
  emptyLabel: string;
  id: string;
  label: string;
  onChange: (choice: LinearChoice | null) => void;
  options: LinearChoice[];
  value: LinearChoice | null;
}) {
  const available = withCurrent(options, value);
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select
        disabled={disabled}
        onValueChange={(selected) =>
          onChange(available.find((option) => option.id === selected) ?? null)
        }
        value={value?.id ?? NO_CHOICE}
      >
        <SelectTrigger className="w-full data-[size=default]:h-9" id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_CHOICE}>{emptyLabel}</SelectItem>
          {available.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
    </Field>
  );
}
