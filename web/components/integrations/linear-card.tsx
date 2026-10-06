"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";

interface Choice {
  id: string;
  name: string;
}

interface Props {
  bugLabel: Choice | null;
  clientId: string | null;
  clientSecretSet: boolean;
  featureLabel: Choice | null;
  otherLabel: Choice | null;
  project: Choice | null;
  team: Choice | null;
  webhookSecretSet: boolean;
}

const selectClassName =
  "h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm dark:bg-input/30";

export function LinearCard({
  bugLabel,
  clientId,
  clientSecretSet,
  featureLabel,
  otherLabel,
  project,
  team,
  webhookSecretSet,
}: Props) {
  const router = useRouter();
  const [clientIdDraft, setClientIdDraft] = useState(clientId ?? "");
  const [clientSecretDraft, setClientSecretDraft] = useState("");
  const [webhookSecretDraft, setWebhookSecretDraft] = useState("");
  const [teamId, setTeamId] = useState(team?.id ?? "");
  const [projectId, setProjectId] = useState(project?.id ?? "");
  const [bugLabelId, setBugLabelId] = useState(bugLabel?.id ?? "");
  const [featureLabelId, setFeatureLabelId] = useState(featureLabel?.id ?? "");
  const [otherLabelId, setOtherLabelId] = useState(otherLabel?.id ?? "");
  const [teams, setTeams] = useState<Choice[]>(team ? [team] : []);
  const [projects, setProjects] = useState<Choice[]>(project ? [project] : []);
  const [labels, setLabels] = useState<Choice[]>(
    [bugLabel, featureLabel, otherLabel].filter((item) => item != null)
  );
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [loadingOptions, setLoadingOptions] = useState(false);

  useEffect(() => {
    setClientIdDraft(clientId ?? "");
    setClientSecretDraft("");
    setWebhookSecretDraft("");
    setTeamId(team?.id ?? "");
    setProjectId(project?.id ?? "");
    setBugLabelId(bugLabel?.id ?? "");
    setFeatureLabelId(featureLabel?.id ?? "");
    setOtherLabelId(otherLabel?.id ?? "");
  }, [
    bugLabel?.id,
    clientId,
    featureLabel?.id,
    otherLabel?.id,
    project?.id,
    team?.id,
  ]);

  useEffect(() => {
    if (!clientSecretSet) {
      return;
    }
    let cancelled = false;
    setLoadingOptions(true);
    const teamQuery = teamId ? `?team_id=${encodeURIComponent(teamId)}` : "";
    fetch(`/api/v1/settings/integrations/linear/options${teamQuery}`)
      .then(async (res) => {
        if (!res.ok) {
          return null;
        }
        return (await res.json()) as {
          labels: Choice[] | null;
          projects: Choice[] | null;
          teams: Choice[];
        };
      })
      .then((body) => {
        if (cancelled || !body) {
          return;
        }
        setTeams(body.teams);
        setProjects(body.projects ?? []);
        setLabels(body.labels ?? []);
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingOptions(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [clientSecretSet, teamId]);

  async function handleTest() {
    const body: Record<string, string> = {};
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
    const body: Record<string, string | null> = {};
    if (clientIdDraft.trim() !== (clientId ?? "")) {
      body.client_id = clientIdDraft.trim() || null;
    }
    if (clientSecretDraft.trim()) {
      body.client_secret = clientSecretDraft.trim();
    }
    if (webhookSecretDraft.trim()) {
      body.webhook_secret = webhookSecretDraft.trim();
    }
    if (teamId !== (team?.id ?? "")) {
      const selected = teams.find((item) => item.id === teamId);
      body.team_id = teamId || null;
      body.team_name = selected?.name ?? null;
      body.project_id = null;
      body.project_name = null;
      body.bug_label_id = null;
      body.bug_label_name = null;
      body.feature_label_id = null;
      body.feature_label_name = null;
      body.other_label_id = null;
      body.other_label_name = null;
    } else if (teamId) {
      assignChoice(body, "project", projectId, projects, project?.id ?? "");
      assignChoice(body, "bug_label", bugLabelId, labels, bugLabel?.id ?? "");
      assignChoice(
        body,
        "feature_label",
        featureLabelId,
        labels,
        featureLabel?.id ?? ""
      );
      assignChoice(
        body,
        "other_label",
        otherLabelId,
        labels,
        otherLabel?.id ?? ""
      );
    }
    if (Object.keys(body).length === 0) {
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/v1/settings/integrations/linear", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await res.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      if (!res.ok) {
        toast.error(payload?.error?.message ?? "Couldn't save Linear settings");
        return;
      }
      toast.success("Linear settings saved");
      setClientSecretDraft("");
      setWebhookSecretDraft("");
      router.refresh();
    } catch {
      toast.error("Couldn't save Linear settings");
    } finally {
      setSaving(false);
    }
  }

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
            <Field>
              <FieldLabel htmlFor="linear-client-id">Client ID</FieldLabel>
              <Input
                autoComplete="off"
                className="font-mono"
                id="linear-client-id"
                onChange={(event) => setClientIdDraft(event.target.value)}
                spellCheck={false}
                value={clientIdDraft}
              />
            </Field>
            <Field>
              <div className="flex items-center justify-between gap-2">
                <FieldLabel htmlFor="linear-client-secret">
                  Client secret
                </FieldLabel>
                <Badge variant="secondary">
                  {clientSecretSet ? "Saved" : "Not set"}
                </Badge>
              </div>
              <Input
                autoComplete="off"
                className="font-mono"
                id="linear-client-secret"
                onChange={(event) => setClientSecretDraft(event.target.value)}
                placeholder={
                  clientSecretSet
                    ? "Paste a new secret to replace it"
                    : "Paste the client secret"
                }
                spellCheck={false}
                type="password"
                value={clientSecretDraft}
              />
            </Field>
            <Field>
              <div className="flex items-center justify-between gap-2">
                <FieldLabel htmlFor="linear-webhook-secret">
                  Webhook signing secret
                </FieldLabel>
                <Badge variant="secondary">
                  {webhookSecretSet ? "Saved" : "Not set"}
                </Badge>
              </div>
              <Input
                autoComplete="off"
                className="font-mono"
                id="linear-webhook-secret"
                onChange={(event) => setWebhookSecretDraft(event.target.value)}
                placeholder={
                  webhookSecretSet
                    ? "Paste a new secret to replace it"
                    : "Paste the signing secret"
                }
                spellCheck={false}
                type="password"
                value={webhookSecretDraft}
              />
              <FieldDescription>
                From the webhook's page in Linear. Data Hub uses it later to
                check that status updates really came from Linear.
              </FieldDescription>
            </Field>
            <ChoiceSelect
              disabled={!clientSecretSet || loadingOptions}
              emptyLabel="No team"
              id="linear-team"
              label="Team"
              onChange={(value) => {
                setTeamId(value);
                setProjectId("");
                setBugLabelId("");
                setFeatureLabelId("");
                setOtherLabelId("");
              }}
              options={withCurrent(teams, team)}
              value={teamId}
            />
            <ChoiceSelect
              disabled={!teamId || loadingOptions}
              emptyLabel="No project"
              id="linear-project"
              label="Project"
              onChange={setProjectId}
              options={withCurrent(projects, project)}
              value={projectId}
            />
            <ChoiceSelect
              disabled={!teamId || loadingOptions}
              emptyLabel="No label"
              id="linear-bug-label"
              label="Bug label"
              onChange={setBugLabelId}
              options={withCurrent(labels, bugLabel)}
              value={bugLabelId}
            />
            <ChoiceSelect
              disabled={!teamId || loadingOptions}
              emptyLabel="No label"
              id="linear-feature-label"
              label="Feature request label"
              onChange={setFeatureLabelId}
              options={withCurrent(labels, featureLabel)}
              value={featureLabelId}
            />
            <ChoiceSelect
              disabled={!teamId || loadingOptions}
              emptyLabel="No label"
              id="linear-other-label"
              label="Other label"
              onChange={setOtherLabelId}
              options={withCurrent(labels, otherLabel)}
              value={otherLabelId}
            />
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
            <Button disabled={saving} onClick={handleSave} type="button">
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

function withCurrent(options: Choice[], current: Choice | null): Choice[] {
  if (!current || options.some((option) => option.id === current.id)) {
    return options;
  }
  return [current, ...options];
}

function assignChoice(
  body: Record<string, string | null>,
  key: string,
  selectedId: string,
  options: Choice[],
  savedId: string
) {
  if (selectedId === savedId) {
    return;
  }
  const selected = options.find((option) => option.id === selectedId);
  body[`${key}_id`] = selectedId || null;
  body[`${key}_name`] = selected?.name ?? null;
}

function ChoiceSelect({
  disabled,
  emptyLabel,
  id,
  label,
  onChange,
  options,
  value,
}: {
  disabled: boolean;
  emptyLabel: string;
  id: string;
  label: string;
  onChange: (value: string) => void;
  options: Choice[];
  value: string;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <select
        className={selectClassName}
        disabled={disabled}
        id={id}
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        <option value="">{emptyLabel}</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
    </Field>
  );
}
