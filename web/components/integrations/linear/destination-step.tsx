"use client";

import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { FeedbackKindBadge } from "@/components/feedback/feedback-badges";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { feedbackKindSchema } from "@/lib/api/feedback-schema";
import {
  type LinearOptions,
  type SetupChoice,
  type SetupLabels,
  useLinearSetup,
} from "./linear-setup-context";

const NO_CHOICE = "__none__";

const EMPTY_LABELS: SetupLabels = {
  bug: null,
  feature_request: null,
  other: null,
};

export function DestinationStep() {
  const { data, goTo, loadOptions, saveDestination } = useLinearSetup();
  const [team, setTeam] = useState<SetupChoice | null>(data.team);
  const [project, setProject] = useState<SetupChoice | null>(data.project);
  const [labels, setLabels] = useState<SetupLabels>(data.labels);
  const [options, setOptions] = useState<LinearOptions>({
    teams: [],
    projects: [],
    labels: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    loadOptions(team?.id ?? null)
      .then((next) => {
        if (!controller.signal.aborted) {
          setOptions(next);
        }
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          setError(
            err instanceof Error ? err.message : "Couldn't load from Linear"
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [loadOptions, team?.id]);

  function changeTeam(next: SetupChoice | null) {
    if (next?.id !== team?.id) {
      setProject(next?.id === data.team?.id ? data.project : null);
      setLabels(next?.id === data.team?.id ? data.labels : EMPTY_LABELS);
    }
    setTeam(next);
  }

  const teamChanged = Boolean(data.team && team && team.id !== data.team.id);

  return (
    <div className="flex flex-col gap-4">
      <ChoiceSelect
        description="Only public teams are listed. Linear doesn't show private teams to apps."
        disabled={loading}
        emptyLabel="No team"
        id="linear-team"
        label="Team"
        onChange={changeTeam}
        options={options.teams}
        value={team}
      />
      {teamChanged ? (
        <p className="text-sm">
          Changing the team clears the project and labels. The Linear webhook
          only sends updates for its own team, so status updates wait until the
          webhook points at {team?.name ?? "the new team"}.
        </p>
      ) : data.team ? (
        <p className="text-muted-foreground text-sm">
          The Linear webhook only sends updates for {data.team.name}.
        </p>
      ) : null}
      <ChoiceSelect
        description="Optional"
        disabled={loading || !team}
        emptyLabel="No project"
        id="linear-project"
        label="Project"
        onChange={setProject}
        options={options.projects}
        value={project}
      />
      <div className="flex flex-col gap-2">
        <p className="font-medium text-sm">
          Labels{" "}
          <span className="font-normal text-muted-foreground">Optional</span>
        </p>
        <p className="text-muted-foreground text-sm">
          Linear adds the matching label to each kind of report.
        </p>
        {feedbackKindSchema.options.map((kind) => (
          <div className="flex items-center gap-2" key={kind}>
            <FeedbackKindBadge kind={kind} />
            <span aria-hidden="true" className="text-muted-foreground">
              →
            </span>
            <div className="min-w-0 flex-1">
              <ChoiceSelect
                disabled={loading || !team}
                emptyLabel="No label"
                id={`linear-label-${kind}`}
                label=""
                onChange={(choice) =>
                  setLabels((current) => ({ ...current, [kind]: choice }))
                }
                options={options.labels}
                value={labels[kind]}
              />
            </div>
          </div>
        ))}
      </div>
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
      <div>
        <Button
          disabled={saving || loading || !team}
          onClick={() => {
            if (!team) {
              return;
            }
            setSaving(true);
            saveDestination({ team, project, labels })
              .then(() => goTo("updates"))
              .catch((err: unknown) => {
                setError(err instanceof Error ? err.message : "Couldn't save");
              })
              .finally(() => setSaving(false));
          }}
          type="button"
        >
          {saving ? <Loader2 className="animate-spin" /> : null}
          {data.team ? "Save" : "Save and turn on feedback"}
        </Button>
        {data.team ? null : (
          <p className="mt-2 text-muted-foreground text-sm">
            Everyone sees Send feedback in their account menu after you save.
          </p>
        )}
      </div>
    </div>
  );
}

function withCurrent(
  options: SetupChoice[],
  current: SetupChoice | null
): SetupChoice[] {
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
  onChange: (choice: SetupChoice | null) => void;
  options: SetupChoice[];
  value: SetupChoice | null;
}) {
  const available = withCurrent(options, value);
  return (
    <div className="grid gap-1.5">
      {label ? (
        <label className="font-medium text-sm" htmlFor={id}>
          {label}
        </label>
      ) : null}
      <Select
        disabled={disabled}
        onValueChange={(selected) =>
          onChange(available.find((option) => option.id === selected) ?? null)
        }
        value={value?.id ?? NO_CHOICE}
      >
        <SelectTrigger className="w-full" id={id}>
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
      {description ? (
        <p className="text-muted-foreground text-sm">{description}</p>
      ) : null}
    </div>
  );
}
