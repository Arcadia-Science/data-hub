"use client";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { formatRelativeTime } from "@/lib/utils";
import { useForm } from "@tanstack/react-form";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { z } from "zod";

// Loose PEP 440-ish version match. Mirrors VERSION_REGEX in
// app/api/v1/settings/watcher-release/route.ts so the client surfaces the
// same rule the server enforces — typos are caught inline rather than
// round-tripping through the API just to get a 400 back.
const VERSION_REGEX = /^\d+\.\d+\.\d+([.-].+)?$/;
const VERSION_MESSAGE = "Use a PEP 440-style version like 1.2.3 or 1.2.3rc1.";

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
  channel: z
    .string()
    .refine((v) => v.trim().length > 0, { message: "Channel can't be empty." }),
  mandatory: z.boolean(),
});

type WatcherReleaseFormValues = z.input<typeof formSchema>;

type LastUpdated = {
  at: string;
  byName: string | null;
  byEmail: string | null;
};

type WatcherReleaseFormProps = {
  initial: WatcherReleaseFormValues;
  lastUpdated: LastUpdated | null;
};

export function WatcherReleaseForm({
  initial,
  lastUpdated,
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
      const res = await fetch("/api/v1/settings/watcher-release", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Server accepts string|null; sending the trimmed string
          // (possibly empty) lets the server's normaliser convert ""→null
          // so the wire contract stays "empty means unset" everywhere.
          latest_version: value.latestVersion.trim() || null,
          min_supported_version: value.minSupportedVersion.trim() || null,
          channel: value.channel.trim(),
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
      // router.refresh() re-runs the page's server component so the "last
      // updated by" line re-renders with the just-saved values — no need
      // to thread the response back into client state.
      router.refresh();
    },
  });

  return (
    // The Card wrapper mirrors Vercel's project-settings panel pattern:
    // heading + description, form fields, then a CardFooter holding the
    // meta + Save action separated by a single border. The Card spans
    // the full width of the page area; CardHeader/CardContent and the
    // inner footer row are capped at `max-w-2xl` so input rows and body
    // copy stay at a readable measure regardless of viewport.
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
        <CardHeader>
          <CardTitle className="text-lg font-semibold tracking-tight">
            Watcher Version
          </CardTitle>
          <CardDescription>
            Configure the release advertised by{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs dark:bg-background/40">
              GET /api/v1/watchers/:id/update-check
            </code>
            .<br /> Watchers compare their installed version against{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs dark:bg-background/40">
              latest_version
            </code>{" "}
            and self-upgrade when a newer release is offered.
          </CardDescription>
        </CardHeader>

        <CardContent className="max-w-2xl">
          <FieldGroup>
            <form.Field name="latestVersion">
              {(field) => {
                const isInvalid =
                  field.state.meta.isTouched && !field.state.meta.isValid;
                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor={field.name}>Latest version</FieldLabel>
                    <Input
                      id={field.name}
                      name={field.name}
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                      placeholder="e.g. 0.4.2"
                      autoComplete="off"
                      spellCheck={false}
                      aria-invalid={isInvalid}
                      className="font-mono"
                    />
                    <FieldDescription>
                      The release watchers will self-upgrade to. Leave blank to
                      temporarily disable self-updates (the endpoint returns{" "}
                      <code className="font-mono">latest_version: null</code>{" "}
                      and clients skip the upgrade).
                    </FieldDescription>
                    {isInvalid && (
                      <FieldError errors={field.state.meta.errors} />
                    )}
                  </Field>
                );
              }}
            </form.Field>

            <form.Field name="minSupportedVersion">
              {(field) => {
                const isInvalid =
                  field.state.meta.isTouched && !field.state.meta.isValid;
                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor={field.name}>
                      Minimum supported version
                    </FieldLabel>
                    <Input
                      id={field.name}
                      name={field.name}
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                      placeholder="e.g. 0.1.0"
                      autoComplete="off"
                      spellCheck={false}
                      aria-invalid={isInvalid}
                      className="font-mono"
                    />
                    <FieldDescription>
                      Optional floor surfaced in the response for future use.
                      Not yet enforced server-side.
                    </FieldDescription>
                    {isInvalid && (
                      <FieldError errors={field.state.meta.errors} />
                    )}
                  </Field>
                );
              }}
            </form.Field>

            <form.Field name="channel">
              {(field) => {
                const isInvalid =
                  field.state.meta.isTouched && !field.state.meta.isValid;
                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor={field.name}>
                      Release channel
                    </FieldLabel>
                    <Input
                      id={field.name}
                      name={field.name}
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                      placeholder="stable"
                      autoComplete="off"
                      spellCheck={false}
                      aria-invalid={isInvalid}
                      className="font-mono"
                    />
                    <FieldDescription>
                      Defaults to <code className="font-mono">stable</code>.
                      Surfaced in the response and shown in{" "}
                      <code className="font-mono">self-update</code> output.
                    </FieldDescription>
                    {isInvalid && (
                      <FieldError errors={field.state.meta.errors} />
                    )}
                  </Field>
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
                          htmlFor={field.name}
                          className={
                            latestVersionEmpty
                              ? "text-muted-foreground"
                              : undefined
                          }
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
                        id={field.name}
                        name={field.name}
                        checked={field.state.value && !latestVersionEmpty}
                        onCheckedChange={field.handleChange}
                        disabled={latestVersionEmpty || isSubmitting}
                        aria-label="Toggle mandatory update"
                      />
                    </Field>
                  )}
                </form.Subscribe>
              )}
            </form.Field>
          </FieldGroup>
        </CardContent>

        {/* Footer keeps full card width so its top border runs
            edge-to-edge; the inner row is capped at the same max-w-2xl
            as the body so the action row visually aligns with the
            field column above. */}
        <CardFooter className="border-t">
          <div className="flex w-full items-center justify-between gap-4">
            {lastUpdated ? (
              <p
                className="text-xs text-muted-foreground"
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
              <p className="text-xs text-muted-foreground">
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
                channelEmpty: state.values.channel.trim().length === 0,
              })}
            >
              {({ canSubmit, isSubmitting, channelEmpty }) => (
                <Button type="submit" disabled={!canSubmit || channelEmpty}>
                  {isSubmitting ? (
                    <Loader2
                      data-icon="inline-start"
                      className="animate-spin"
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
