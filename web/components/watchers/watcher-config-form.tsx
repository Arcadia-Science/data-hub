"use client";

import { Eye, Loader2, Plus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { WATCHER_FEATURES } from "@/lib/api/watcher-compat";
import {
  FILE_PATTERNS_MAX,
  MAX_STABILITY_WAIT_RANGE,
  RUN_DETECTION_PRESETS,
  STABILITY_PERIOD_RANGE,
  settingsEqual,
  UPLOAD_PARALLELISM_RANGE,
  type WatcherConfigSettings,
  watcherConfigSettingsSchema,
} from "@/lib/api/watcher-config/settings";
import { cn } from "@/lib/utils";

const CUSTOM_PRESET = "custom";

export const REMOTE_CONFIG_VERSION_LABEL = WATCHER_FEATURES.remoteConfig;

interface PatternRow {
  id: number;
  value: string;
}

interface FormState {
  maxStabilityWait: string;
  patterns: PatternRow[];
  recursive: boolean;
  runPattern: string;
  stabilityPeriod: string;
  uploadMode: "auto" | "manual";
  uploadParallelism: string;
  watchDirectory: string;
}

function toFormState(settings: WatcherConfigSettings): FormState {
  return {
    watchDirectory: settings.watch_directory,
    patterns: settings.file_patterns.map((value, id) => ({ id, value })),
    runPattern: settings.run_detection.pattern,
    recursive: settings.run_detection.recursive,
    uploadMode: settings.upload_mode,
    stabilityPeriod: String(settings.stability_period_seconds),
    maxStabilityWait: String(settings.max_stability_wait_seconds),
    uploadParallelism: String(settings.upload_parallelism),
  };
}

// Empty or non-numeric input becomes NaN, which the schema rejects.
function toNumber(raw: string): number {
  return raw.trim() === "" ? Number.NaN : Number(raw);
}

function toCandidate(state: FormState) {
  return {
    watch_directory: state.watchDirectory.trim(),
    file_patterns: state.patterns.map((p) => p.value),
    run_detection: { pattern: state.runPattern, recursive: state.recursive },
    upload_mode: state.uploadMode,
    stability_period_seconds: toNumber(state.stabilityPeriod),
    max_stability_wait_seconds: toNumber(state.maxStabilityWait),
    upload_parallelism: toNumber(state.uploadParallelism),
  };
}

// Field errors keyed by the setting's path, such as `file_patterns.1`.
function fieldErrors(candidate: unknown) {
  const parsed = watcherConfigSettingsSchema.safeParse(candidate);
  if (parsed.success) {
    return { settings: parsed.data, errors: new Map<string, string>() };
  }
  const errors = new Map<string, string>();
  for (const issue of parsed.error.issues) {
    const key = issue.path.join(".");
    if (!errors.has(key)) {
      errors.set(
        key,
        issue.code === "invalid_type" ? "Enter a whole number" : issue.message
      );
    }
  }
  return { settings: null, errors };
}

interface PreviewResult {
  files: { relative_path: string; matches: boolean; run_id: string | null }[];
  sample_size: number;
}

async function readError(res: Response, fallback: string) {
  const body = await res.json().catch(() => null);
  return {
    message: (body?.error?.message as string | undefined) ?? fallback,
    reason: body?.error?.details?.reason as string | undefined,
  };
}

/**
 * Structured editor for a watcher's web-editable settings, used on the
 * watcher's Configuration tab and in the instrument page's dialog. Saving
 * stores a pending revision that the watcher applies after its next
 * heartbeat. Remount it (with `key`) when the base revision changes.
 */
export function WatcherConfigForm({
  watcherId,
  baseRevision,
  initialSettings,
  editable,
  watcherVersion,
  onSaved,
}: {
  watcherId: string;
  /** The latest revision number, sent back so stale saves are refused. */
  baseRevision: number | null;
  initialSettings: WatcherConfigSettings;
  /** False below watcher 1.3.0: the form shows but can't be changed. */
  editable: boolean;
  watcherVersion: string | null;
  onSaved?: () => void;
}) {
  const router = useRouter();
  const idPrefix = useId();
  const nextPatternId = useRef(initialSettings.file_patterns.length);
  const [state, setState] = useState<FormState>(() =>
    toFormState(initialSettings)
  );
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [isSaving, startSaving] = useTransition();
  const [isPreviewing, startPreviewing] = useTransition();

  const { settings, errors } = useMemo(
    () => fieldErrors(toCandidate(state)),
    [state]
  );
  const unchanged =
    settings !== null && settingsEqual(settings, initialSettings);
  const presetKey =
    RUN_DETECTION_PRESETS.find((p) => p.pattern === state.runPattern)?.key ??
    CUSTOM_PRESET;

  function update(patch: Partial<FormState>) {
    setState((prev) => ({ ...prev, ...patch }));
    setPreview(null);
  }

  function updatePattern(id: number, value: string) {
    update({
      patterns: state.patterns.map((p) => (p.id === id ? { ...p, value } : p)),
    });
  }

  function addPattern() {
    const id = nextPatternId.current;
    nextPatternId.current += 1;
    update({ patterns: [...state.patterns, { id, value: "" }] });
  }

  function removePattern(id: number) {
    update({ patterns: state.patterns.filter((p) => p.id !== id) });
  }

  function choosePreset(key: string) {
    const preset = RUN_DETECTION_PRESETS.find((p) => p.key === key);
    if (preset) {
      update({ runPattern: preset.pattern, recursive: preset.recursive });
    }
  }

  function runPreview() {
    if (!settings) {
      return;
    }
    startPreviewing(async () => {
      const res = await fetch(`/api/v1/watchers/${watcherId}/config-preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings }),
      });
      if (!res.ok) {
        const { message } = await readError(res, "Couldn't preview the change");
        toast.error(message);
        return;
      }
      setPreview((await res.json()) as PreviewResult);
    });
  }

  function save() {
    if (!settings) {
      return;
    }
    startSaving(async () => {
      const res = await fetch(
        `/api/v1/watchers/${watcherId}/config-revisions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ base_revision: baseRevision, settings }),
        }
      );
      if (!res.ok) {
        const { message, reason } = await readError(
          res,
          "Couldn't save the change"
        );
        toast.error(message);
        if (reason === "stale_revision") {
          router.refresh();
        }
        return;
      }
      toast.success("Change saved", {
        description: "The watcher applies it within about a minute.",
      });
      onSaved?.();
      router.refresh();
    });
  }

  const id = (name: string) => `${idPrefix}-${name}`;
  const errorFor = (key: string) => errors.get(key);
  const matchedCount = preview?.files.filter((f) => f.matches).length ?? 0;

  return (
    <div className="flex flex-col gap-5">
      {editable ? null : (
        <Alert>
          <AlertDescription>
            Update the watcher to {REMOTE_CONFIG_VERSION_LABEL} to edit its
            config here.
            {watcherVersion ? ` It runs ${watcherVersion}.` : ""}
          </AlertDescription>
        </Alert>
      )}

      <fieldset
        className="flex flex-col gap-5"
        disabled={!editable || isSaving}
      >
        <Field
          error={errorFor("watch_directory")}
          hint="Admins can point this at any folder on the instrument PC. The watcher checks that the folder exists before it switches."
          htmlFor={id("folder")}
          label="Watch folder"
        >
          <Input
            aria-invalid={Boolean(errorFor("watch_directory"))}
            className="font-mono"
            id={id("folder")}
            onChange={(e) => update({ watchDirectory: e.target.value })}
            placeholder="D:\Exports\Plate reader"
            value={state.watchDirectory}
          />
        </Field>

        <div className="grid gap-2">
          <Label>File patterns</Label>
          <ul className="grid gap-2">
            {state.patterns.map((pattern, index) => {
              const error = errorFor(`file_patterns.${index}`);
              return (
                <li className="grid gap-1" key={pattern.id}>
                  <div className="flex items-center gap-2">
                    <Input
                      aria-invalid={Boolean(error)}
                      aria-label={`File pattern ${index + 1}`}
                      className="font-mono"
                      onChange={(e) =>
                        updatePattern(pattern.id, e.target.value)
                      }
                      placeholder="*.csv"
                      value={pattern.value}
                    />
                    <Button
                      aria-label={`Remove pattern ${pattern.value || index + 1}`}
                      disabled={state.patterns.length <= 1}
                      onClick={() => removePattern(pattern.id)}
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                  {error ? <FieldError>{error}</FieldError> : null}
                </li>
              );
            })}
          </ul>
          <div>
            <Button
              disabled={state.patterns.length >= FILE_PATTERNS_MAX}
              onClick={addPattern}
              size="sm"
              type="button"
              variant="outline"
            >
              <Plus data-icon="inline-start" />
              Add pattern
            </Button>
          </div>
          {errorFor("file_patterns") ? (
            <FieldError>{errorFor("file_patterns")}</FieldError>
          ) : null}
          <p className="text-muted-foreground text-xs">
            Matched against each file&apos;s name, case-sensitive. For example,{" "}
            <code>*.csv</code> doesn&apos;t match <code>DATA.CSV</code>.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field htmlFor={id("preset")} label="Run detection">
            <Select onValueChange={choosePreset} value={presetKey}>
              <SelectTrigger
                className="w-full data-[size=default]:h-9"
                id={id("preset")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RUN_DETECTION_PRESETS.map((preset) => (
                  <SelectItem key={preset.key} value={preset.key}>
                    {preset.label}
                  </SelectItem>
                ))}
                <SelectItem disabled value={CUSTOM_PRESET}>
                  Custom pattern
                </SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field
            error={errorFor("run_detection.pattern")}
            hint="A regular expression with one capture group. Group 1 is the run ID."
            htmlFor={id("regex")}
            label="Pattern"
          >
            <Input
              aria-invalid={Boolean(errorFor("run_detection.pattern"))}
              className="font-mono"
              id={id("regex")}
              onChange={(e) => update({ runPattern: e.target.value })}
              value={state.runPattern}
            />
          </Field>
        </div>

        <div className="flex items-center gap-3">
          <Switch
            checked={state.recursive}
            id={id("recursive")}
            onCheckedChange={(checked) => update({ recursive: checked })}
          />
          <Label htmlFor={id("recursive")}>Include subfolders</Label>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            hint={
              state.uploadMode === "auto"
                ? "New files upload as soon as they stop changing."
                : "New files are reported only. Someone requests the upload from the run page."
            }
            htmlFor={id("mode")}
            label="Upload mode"
          >
            <Select
              onValueChange={(value) =>
                update({ uploadMode: value as "auto" | "manual" })
              }
              value={state.uploadMode}
            >
              <SelectTrigger
                className="w-full data-[size=default]:h-9"
                id={id("mode")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Automatic</SelectItem>
                <SelectItem value="manual">Manual</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <NumberField
            error={errorFor("upload_parallelism")}
            hint="How many files upload at once."
            id={id("parallelism")}
            label="Parallel uploads"
            onChange={(value) => update({ uploadParallelism: value })}
            range={UPLOAD_PARALLELISM_RANGE}
            value={state.uploadParallelism}
          />
          <NumberField
            error={errorFor("stability_period_seconds")}
            hint="How long a file must stay unchanged before it counts as finished."
            id={id("stability")}
            label="Stability period (seconds)"
            onChange={(value) => update({ stabilityPeriod: value })}
            range={STABILITY_PERIOD_RANGE}
            value={state.stabilityPeriod}
          />
          <NumberField
            error={errorFor("max_stability_wait_seconds")}
            hint="How long to wait for a file that keeps changing before giving up."
            id={id("max-wait")}
            label="Max stability wait (seconds)"
            onChange={(value) => update({ maxStabilityWait: value })}
            range={MAX_STABILITY_WAIT_RANGE}
            value={state.maxStabilityWait}
          />
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={!(editable && settings) || unchanged || isSaving}
          onClick={save}
          type="button"
        >
          {isSaving ? (
            <Loader2 className="animate-spin" data-icon="inline-start" />
          ) : null}
          Save change
        </Button>
        <Button
          disabled={!(editable && settings) || isPreviewing}
          onClick={runPreview}
          type="button"
          variant="outline"
        >
          {isPreviewing ? (
            <Loader2 className="animate-spin" data-icon="inline-start" />
          ) : (
            <Eye data-icon="inline-start" />
          )}
          Preview with recent files
        </Button>
        {editable && !unchanged ? (
          <Button
            disabled={isSaving}
            onClick={() => {
              setState(toFormState(initialSettings));
              setPreview(null);
            }}
            type="button"
            variant="ghost"
          >
            Discard changes
          </Button>
        ) : null}
      </div>

      {preview ? (
        <PreviewTable matchedCount={matchedCount} preview={preview} />
      ) : null}
    </div>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid content-start gap-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? <FieldError>{error}</FieldError> : null}
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
    </div>
  );
}

function FieldError({ children }: { children: React.ReactNode }) {
  return <p className="text-destructive text-xs">{children}</p>;
}

function NumberField({
  id,
  label,
  hint,
  error,
  range,
  value,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  error?: string;
  range: { min: number; max: number };
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field error={error} hint={hint} htmlFor={id} label={label}>
      <Input
        aria-invalid={Boolean(error)}
        id={id}
        inputMode="numeric"
        max={range.max}
        min={range.min}
        onChange={(e) => onChange(e.target.value)}
        step={1}
        type="number"
        value={value}
      />
    </Field>
  );
}

function PreviewTable({
  preview,
  matchedCount,
}: {
  preview: PreviewResult;
  matchedCount: number;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">
        {preview.sample_size === 0
          ? "Data Hub hasn't seen any files from this instrument yet."
          : `${matchedCount} of the ${preview.sample_size} most recent files would match.`}
      </p>
      <p className="text-muted-foreground text-xs">
        This only covers files Data Hub already knows about. Files on the PC
        that never matched a pattern can&apos;t be listed here.
      </p>
      {preview.files.length > 0 ? (
        <div className="max-h-80 overflow-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>File</TableHead>
                <TableHead>Matches</TableHead>
                <TableHead>Run ID</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {preview.files.map((file) => (
                <TableRow
                  className={cn("text-sm", !file.matches && "opacity-60")}
                  key={file.relative_path}
                >
                  <TableCell className="max-w-96 break-all font-mono text-xs">
                    {file.relative_path}
                  </TableCell>
                  <TableCell>
                    <Badge variant={file.matches ? "default" : "secondary"}>
                      {file.matches ? "Yes" : "No"}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {file.run_id ?? (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </div>
  );
}
