"use client";

import { ArrowRightIcon, Loader2 } from "lucide-react";
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
import {
  type FeedbackKind,
  feedbackKindSchema,
} from "@/lib/api/feedback-schema";
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

// Completes "Linear label for ..." in each label picker's accessible name.
const KIND_PHRASE: Record<FeedbackKind, string> = {
  bug: "bug reports",
  feature_request: "feature requests",
  other: "other reports",
};

export function DestinationStep() {
  const { actions, state } = useLinearSetup();
  const { data } = state;
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
  const { loadOptions } = actions;

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

  function save() {
    if (!team) {
      return;
    }
    setSaving(true);
    setError(null);
    actions
      .saveDestination({ team, project, labels })
      .then(() => actions.goTo("updates"))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Couldn't save");
      })
      .finally(() => setSaving(false));
  }

  const teamChanged = Boolean(data.team && team && team.id !== data.team.id);

  return (
    <>
      <div aria-live="polite">
        {loading ? (
          <p className="text-muted-foreground text-sm">
            Loading teams from Linear…
          </p>
        ) : null}
      </div>
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
        <p
          className="text-pretty rounded-lg bg-amber-50 p-3 text-amber-950 text-sm dark:bg-amber-950 dark:text-amber-100"
          role="status"
        >
          Changing the team clears the project and labels. The Linear webhook
          only sends updates for its own team, so status updates wait until the
          webhook points at {team?.name ?? "the new team"}.
        </p>
      ) : data.team ? (
        <p className="text-pretty text-muted-foreground text-sm">
          The Linear webhook only sends updates for {data.team.name}.
        </p>
      ) : null}
      <ChoiceSelect
        disabled={loading || !team}
        emptyLabel="No project"
        id="linear-project"
        label="Project"
        onChange={setProject}
        optional
        options={options.projects}
        value={project}
      />
      <fieldset className="flex min-w-0 flex-col gap-2">
        <legend className="p-0">
          <span className="font-medium text-sm">Labels</span>{" "}
          <span className="font-normal text-muted-foreground text-xs">
            Optional
          </span>
        </legend>
        <p className="text-pretty text-muted-foreground text-sm">
          Linear adds the matching label to each kind of report.
        </p>
        <div className="divide-y overflow-hidden rounded-lg border">
          {feedbackKindSchema.options.map((kind) => (
            <div
              className="grid grid-cols-[minmax(0,1fr)_1rem_minmax(0,1fr)] items-center gap-3 py-2 pr-2 pl-3 sm:grid-cols-[8.75rem_1rem_minmax(0,1fr)]"
              key={kind}
            >
              <span>
                <FeedbackKindBadge kind={kind} />
              </span>
              <ArrowRightIcon
                aria-hidden="true"
                className="size-4 text-muted-foreground"
              />
              <ChoiceSelect
                ariaLabel={`Linear label for ${KIND_PHRASE[kind]}`}
                disabled={loading || !team}
                emptyLabel="No label"
                id={`linear-label-${kind}`}
                onChange={(choice) =>
                  setLabels((current) => ({ ...current, [kind]: choice }))
                }
                options={options.labels}
                value={labels[kind]}
              />
            </div>
          ))}
        </div>
      </fieldset>
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={saving || loading || !team}
          onClick={save}
          type="button"
        >
          {saving ? (
            <Loader2
              aria-hidden="true"
              className="animate-spin motion-reduce:animate-none"
            />
          ) : null}
          {saving
            ? "Saving…"
            : data.team
              ? "Save"
              : "Save and turn on feedback"}
        </Button>
        {data.team ? null : (
          <p className="text-muted-foreground text-sm">
            Everyone sees Send feedback in their account menu after you save.
          </p>
        )}
      </div>
    </>
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

// Pass `label` for a visible label, or `ariaLabel` when the surrounding row
// already shows what the picker is for.
function ChoiceSelect({
  ariaLabel,
  description,
  disabled,
  emptyLabel,
  id,
  label,
  onChange,
  optional = false,
  options,
  value,
}: {
  ariaLabel?: string;
  description?: string;
  disabled: boolean;
  emptyLabel: string;
  id: string;
  label?: string;
  onChange: (choice: SetupChoice | null) => void;
  optional?: boolean;
  options: SetupChoice[];
  value: SetupChoice | null;
}) {
  const available = withCurrent(options, value);
  return (
    <div className="grid min-w-0 gap-2">
      {label ? (
        <div className="flex items-baseline gap-2">
          <label className="font-medium text-sm" htmlFor={id}>
            {label}
          </label>
          {optional ? (
            <span className="text-muted-foreground text-xs">Optional</span>
          ) : null}
        </div>
      ) : null}
      <Select
        disabled={disabled}
        onValueChange={(selected) =>
          onChange(available.find((option) => option.id === selected) ?? null)
        }
        value={value?.id ?? NO_CHOICE}
      >
        <SelectTrigger aria-label={ariaLabel} className="w-full" id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_CHOICE}>{emptyLabel}</SelectItem>
          {available.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              <span className="inline-flex items-center gap-2">
                {option.color ? (
                  <span
                    aria-hidden="true"
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: option.color }}
                  />
                ) : null}
                {option.name}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {description ? (
        <p className="text-pretty text-muted-foreground text-sm">
          {description}
        </p>
      ) : null}
    </div>
  );
}
