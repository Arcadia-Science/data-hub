"use client";

import { useForm, useStore } from "@tanstack/react-form";
import { Loader2 } from "lucide-react";
import { useId, useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useUnsavedChangesWarning } from "@/hooks/use-unsaved-changes-warning";
import {
  notebookLinkLabelInputSchema,
  notebookLinkUrlSchema,
} from "@/lib/notebook-links/url";

const formSchema = z.object({
  url: notebookLinkUrlSchema,
  label: notebookLinkLabelInputSchema,
  claim: z.boolean(),
});

export type NotebookLinkFormValues = z.infer<typeof formSchema>;

/**
 * URL and label fields for adding or editing a lab notebook link. `onSave`
 * returns an error to show under the URL, such as a duplicate link, or null
 * once the link is saved. `claimLabel` adds an "I ran this" checkbox, off by
 * default.
 */
export function NotebookLinkForm({
  variant,
  initialUrl = "",
  initialLabel = "",
  claimLabel,
  note,
  onSave,
  onCancel,
}: {
  variant: "add" | "edit";
  initialUrl?: string;
  initialLabel?: string;
  claimLabel?: string;
  // Shown above the buttons, for example how many runs already have the link.
  note?: (url: string) => React.ReactNode;
  onSave: (values: NotebookLinkFormValues) => Promise<string | null>;
  onCancel: () => void;
}) {
  const id = useId();
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm({
    defaultValues: { url: initialUrl, label: initialLabel, claim: false },
    validators: { onSubmit: formSchema },
    onSubmit: async ({ value }) => {
      setServerError(null);
      const error = await onSave(formSchema.parse(value));
      if (error) {
        setServerError(error);
      }
    },
  });

  const isDirty = useStore(form.store, (state) => !state.isDefaultValue);
  const isSubmitting = useStore(form.store, (state) => state.isSubmitting);
  const url = useStore(form.store, (state) => state.values.url);
  useUnsavedChangesWarning(isDirty);

  return (
    <form
      className="flex flex-col gap-3"
      // The URL field's own messages replace the browser's, so a link
      // without `https://` gets the same explanation as any other bad link.
      noValidate
      onKeyDown={(event) => {
        if (event.key === "Escape" && !isSubmitting) {
          event.stopPropagation();
          onCancel();
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        form.handleSubmit();
      }}
    >
      <FieldGroup className="gap-3">
        <form.Field name="url">
          {(field) => {
            const showError =
              field.state.meta.isTouched && !field.state.meta.isValid;
            return (
              <Field data-invalid={showError || serverError !== null}>
                <FieldLabel htmlFor={`${id}-url`}>URL</FieldLabel>
                <Input
                  aria-invalid={showError || serverError !== null}
                  autoComplete="off"
                  // Opening the form is a request to type a link.
                  autoFocus
                  id={`${id}-url`}
                  inputMode="url"
                  name={field.name}
                  onBlur={field.handleBlur}
                  onChange={(event) => {
                    setServerError(null);
                    field.handleChange(event.target.value);
                  }}
                  placeholder="https://www.notion.so/…"
                  spellCheck={false}
                  type="url"
                  value={field.state.value}
                />
                {showError ? (
                  <FieldError errors={field.state.meta.errors} />
                ) : null}
                {serverError ? <FieldError>{serverError}</FieldError> : null}
              </Field>
            );
          }}
        </form.Field>
        <form.Field name="label">
          {(field) => {
            const showError =
              field.state.meta.isTouched && !field.state.meta.isValid;
            return (
              <Field data-invalid={showError}>
                <FieldLabel htmlFor={`${id}-label`}>
                  Label{" "}
                  <span className="font-normal text-muted-foreground">
                    (optional)
                  </span>
                </FieldLabel>
                <Input
                  aria-invalid={showError}
                  autoComplete="off"
                  id={`${id}-label`}
                  name={field.name}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder="Day 1 heat stress"
                  value={field.state.value}
                />
                {showError ? (
                  <FieldError errors={field.state.meta.errors} />
                ) : null}
              </Field>
            );
          }}
        </form.Field>
        {claimLabel ? (
          <form.Field name="claim">
            {(field) => (
              <Field orientation="horizontal">
                <Checkbox
                  checked={field.state.value}
                  id={`${id}-claim`}
                  onCheckedChange={(checked) =>
                    field.handleChange(checked === true)
                  }
                />
                <FieldLabel className="font-normal" htmlFor={`${id}-claim`}>
                  {claimLabel}
                </FieldLabel>
              </Field>
            )}
          </form.Field>
        ) : null}
      </FieldGroup>
      {note ? note(url) : null}
      <div className="flex justify-end gap-2">
        <Button
          disabled={isSubmitting}
          onClick={onCancel}
          size="sm"
          type="button"
          variant="ghost"
        >
          Cancel
        </Button>
        <Button
          disabled={isSubmitting || (variant === "edit" && !isDirty)}
          size="sm"
          type="submit"
        >
          {isSubmitting ? (
            <Loader2 className="animate-spin" data-icon="inline-start" />
          ) : null}
          {variant === "add" ? "Add link" : "Save"}
        </Button>
      </div>
    </form>
  );
}
