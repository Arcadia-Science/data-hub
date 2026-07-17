"use client";

import { useForm } from "@tanstack/react-form";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { VersionField } from "@/components/watcher-release/version-field";
import { VERSION_MESSAGE, VERSION_REGEX } from "@/lib/api/watcher-versions";
import { formatRelativeTime } from "@/lib/utils";

// Both version fields treat "" as "unset", so empty strings always pass —
// the server's normaliser collapses "" → null on the wire. We only enforce
// the version shape when the user has actually typed something.
const optionalVersion = z.string().refine(
  (v) => {
    const trimmed = v.trim();
    return trimmed.length === 0 || VERSION_REGEX.test(trimmed);
  },
  { message: VERSION_MESSAGE }
);

const formSchema = z.object({
  latestVersion: optionalVersion,
  minSupportedVersion: optionalVersion,
  mandatory: z.boolean(),
});

type WatcherReleaseFormValues = z.input<typeof formSchema>;

interface LastUpdated {
  at: string;
  byEmail: string | null;
  byName: string | null;
}

interface WatcherReleaseFormProps {
  availableVersions: string[];
  initial: WatcherReleaseFormValues;
  lastUpdated: LastUpdated | null;
  pypiReachable: boolean;
}

export function WatcherReleaseForm({
  availableVersions,
  initial,
  lastUpdated,
  pypiReachable,
}: WatcherReleaseFormProps) {
  const router = useRouter();

  // TanStack Form owns field values, validation, and isSubmitting tracking,
  // so we no longer need parallel useState/useTransition state. The schema
  // is reused for onBlur (live feedback after the user leaves a field) and
  // onSubmit (final guard) — keeping the same Zod source of truth as the
  // server route.
  const form = useForm({
    defaultValues: initial,
    validators: {
      onBlur: formSchema,
      onSubmit: formSchema,
    },
    onSubmit: async ({ value }) => {
      // Trim before the wire and before reset so free-text whitespace
      // doesn't leave isDirty=false with a value that differs from the
      // server-persisted row after refresh.
      const latestVersion = value.latestVersion.trim();
      const minSupportedVersion = value.minSupportedVersion.trim();
      const res = await fetch("/api/v1/settings/watcher-release", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Server accepts string|null; sending the trimmed string
          // (possibly empty) lets the server's normaliser convert ""→null
          // so the wire contract stays "empty means unset" everywhere.
          latest_version: latestVersion || null,
          min_supported_version: minSupportedVersion || null,
          // The server collapses mandatory→false on read when
          // latest_version is null, so we don't need to mirror that on
          // write — keep the user's explicit choice in the row.
          mandatory: value.mandatory,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(body?.error?.message ?? "Failed to save watcher release");
        return;
      }

      toast.success("Watcher release saved");
      // Re-baseline to the saved values so `isDirty` resets and the Save
      // button disables until the next edit. router.refresh() still re-runs
      // the server component so the "last updated by" line re-renders.
      form.reset({
        latestVersion,
        minSupportedVersion,
        mandatory: value.mandatory,
      });
      router.refresh();
    },
  });

  return (
    // The form renders as a content-only Card (body + footer separated
    // by a single border). The page-level heading + description live in
    // the route's `page.tsx` so they align with the sibling settings
    // pages and the sidebar "Settings" label. Width is constrained by
    // `SettingsPageContent` on the route; CardContent fills the card.
    //
    // The fields stay in a single Card (rather than one-card-per-field)
    // because they all configure the same logical resource — the
    // singleton release row.
    <form
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        form.handleSubmit();
      }}
    >
      <Card>
        <CardContent>
          <FieldGroup>
            <form.Field name="latestVersion">
              {(field) => {
                const isInvalid =
                  field.state.meta.isTouched && !field.state.meta.isValid;
                return (
                  <VersionField
                    availableVersions={availableVersions}
                    description={
                      <>
                        The release watchers will self-upgrade to. Leave blank
                        to temporarily disable self-updates (the endpoint
                        returns{" "}
                        <code className="font-mono">latest_version: null</code>{" "}
                        and clients skip the upgrade).
                      </>
                    }
                    errors={field.state.meta.errors}
                    id={field.name}
                    isInvalid={isInvalid}
                    label="Latest version"
                    noneLabel="None — disable self-updates"
                    onBlur={field.handleBlur}
                    onChange={field.handleChange}
                    placeholder="e.g. 0.4.2"
                    pypiReachable={pypiReachable}
                    value={field.state.value}
                  />
                );
              }}
            </form.Field>

            <form.Field name="minSupportedVersion">
              {(field) => {
                const isInvalid =
                  field.state.meta.isTouched && !field.state.meta.isValid;
                return (
                  <VersionField
                    availableVersions={availableVersions}
                    description={
                      <>
                        Optional floor. Watchers reporting an installed version
                        below this have their heartbeats rejected with{" "}
                        <code className="font-mono">426 Upgrade Required</code>,
                        forcing them to self-update before they can check in
                        again. Leave blank to disable the floor.
                      </>
                    }
                    errors={field.state.meta.errors}
                    id={field.name}
                    isInvalid={isInvalid}
                    label="Minimum supported version"
                    noneLabel="None — no version floor"
                    onBlur={field.handleBlur}
                    onChange={field.handleChange}
                    placeholder="e.g. 0.1.0"
                    pypiReachable={pypiReachable}
                    value={field.state.value}
                  />
                );
              }}
            </form.Field>

            <form.Field name="mandatory">
              {(field) => (
                // Nested Subscribe so this row re-renders when
                // latestVersion or isSubmitting changes — the other
                // form.Field render-props above stay subscribed only to
                // their own field state. Selector returns a small object
                // of primitives per rerender-derived-state.
                <form.Subscribe
                  selector={(state) => ({
                    latestVersionEmpty:
                      state.values.latestVersion.trim().length === 0,
                    isSubmitting: state.isSubmitting,
                  })}
                >
                  {({ latestVersionEmpty, isSubmitting }) => (
                    <Field orientation="horizontal">
                      <FieldContent>
                        <FieldLabel
                          className={
                            latestVersionEmpty
                              ? "text-muted-foreground"
                              : undefined
                          }
                          htmlFor={field.name}
                        >
                          Mandatory update
                        </FieldLabel>
                        <FieldDescription>
                          Skip the watcher&apos;s activity-window guard so
                          mid-acquisition PCs upgrade immediately. Reserve for
                          security fixes or wire-protocol breaks. Has no effect
                          when the latest version is blank.
                        </FieldDescription>
                      </FieldContent>
                      {/* checked = value && !empty mirrors the original
                          "visually off when disabled" UX. We don't flip
                          the underlying value because the server
                          collapses mandatory→false on read when
                          latest_version is null anyway, so the user's
                          choice survives clearing/restoring the version
                          field. */}
                      <Switch
                        aria-label="Toggle mandatory update"
                        checked={field.state.value && !latestVersionEmpty}
                        disabled={latestVersionEmpty || isSubmitting}
                        id={field.name}
                        name={field.name}
                        onCheckedChange={field.handleChange}
                      />
                    </Field>
                  )}
                </form.Subscribe>
              )}
            </form.Field>
          </FieldGroup>
        </CardContent>

        {/* Footer keeps full card width so its top border runs edge-to-edge. */}
        <CardFooter className="border-t">
          <div className="flex w-full items-center justify-between gap-4">
            {lastUpdated ? (
              <p
                className="text-muted-foreground text-xs"
                suppressHydrationWarning
              >
                Last updated{" "}
                <span title={new Date(lastUpdated.at).toLocaleString()}>
                  {formatRelativeTime(lastUpdated.at)}
                </span>
                {lastUpdated.byName || lastUpdated.byEmail ? (
                  <>
                    {" by "}
                    <span className="font-medium text-foreground">
                      {lastUpdated.byName ?? lastUpdated.byEmail}
                    </span>
                  </>
                ) : null}
                .
              </p>
            ) : (
              <p className="text-muted-foreground text-xs">
                No release configured yet. Watchers will skip self-updates until
                you save a version.
              </p>
            )}
            {/* Subscribing to a small primitive-shaped selector keeps
                re-renders scoped to just this button. */}
            <form.Subscribe
              selector={(state) => ({
                canSubmit: state.canSubmit,
                isSubmitting: state.isSubmitting,
                isDirty: state.isDirty,
              })}
            >
              {({ canSubmit, isSubmitting, isDirty }) => (
                <Button disabled={!(canSubmit && isDirty)} type="submit">
                  {isSubmitting ? (
                    <Loader2
                      className="animate-spin"
                      data-icon="inline-start"
                    />
                  ) : null}
                  Save
                </Button>
              )}
            </form.Subscribe>
          </div>
        </CardFooter>
      </Card>
    </form>
  );
}
