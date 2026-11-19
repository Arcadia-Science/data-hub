"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, type Ref, useTransition } from "react";
import { toast } from "sonner";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { notebookPageHref } from "@/lib/notebooks/details";
import {
  NotebookRequestError,
  restoreNotebook,
} from "@/lib/runs/notebook-requests";

// The fields the New notebook and Edit details dialogs share. Each takes its
// value, its error, and a change handler, so a dialog can put them in its own
// order and keep its own state.

interface TextFieldProps<E extends HTMLElement> {
  error?: string;
  hint?: ReactNode;
  id: string;
  inputRef?: Ref<E>;
  onChange: (value: string) => void;
  value: string;
}

function describedBy(id: string, hint: ReactNode, error?: string) {
  const ids = [hint ? `${id}-hint` : null, error ? `${id}-error` : null];
  return ids.filter(Boolean).join(" ") || undefined;
}

export function NotebookLinkField({
  autoFocus,
  error,
  hint,
  id,
  inputRef,
  onChange,
  value,
}: TextFieldProps<HTMLInputElement> & { autoFocus?: boolean }) {
  return (
    <Field data-invalid={error !== undefined}>
      <FieldLabel htmlFor={id}>Link</FieldLabel>
      <Input
        aria-describedby={describedBy(id, hint, error)}
        aria-invalid={error !== undefined}
        autoComplete="off"
        autoFocus={autoFocus}
        id={id}
        inputMode="url"
        onChange={(event) => onChange(event.target.value)}
        placeholder="https://www.notion.so/…"
        ref={inputRef}
        spellCheck={false}
        value={value}
      />
      {hint ? (
        <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription>
      ) : null}
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </Field>
  );
}

export function NotebookNameField({
  error,
  hint,
  id,
  inputRef,
  onChange,
  value,
}: TextFieldProps<HTMLInputElement>) {
  return (
    <Field data-invalid={error !== undefined}>
      <FieldLabel htmlFor={id}>Name</FieldLabel>
      <Input
        aria-describedby={describedBy(id, hint, error)}
        aria-invalid={error !== undefined}
        autoComplete="off"
        id={id}
        onChange={(event) => onChange(event.target.value)}
        ref={inputRef}
        value={value}
      />
      {hint ? (
        <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription>
      ) : null}
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </Field>
  );
}

export function NotebookDescriptionField({
  error,
  id,
  inputRef,
  onChange,
  value,
}: TextFieldProps<HTMLTextAreaElement>) {
  return (
    <Field data-invalid={error !== undefined}>
      <FieldLabel htmlFor={id}>
        Description
        <span className="font-normal text-muted-foreground">(optional)</span>
      </FieldLabel>
      <Textarea
        aria-describedby={describedBy(id, null, error)}
        aria-invalid={error !== undefined}
        className="min-h-20"
        id={id}
        onChange={(event) => onChange(event.target.value)}
        ref={inputRef}
        value={value}
      />
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </Field>
  );
}

/** A 409 from the API: another notebook already has the page. */
export interface PageTakenConflict {
  deleted: boolean;
  message: string;
  notebookId: string;
}

/** The conflict in a failed save, or null when it failed for another reason. */
export function pageTakenConflict(error: unknown): PageTakenConflict | null {
  if (
    error instanceof NotebookRequestError &&
    error.status === 409 &&
    error.notebookId
  ) {
    return {
      message: error.message,
      notebookId: error.notebookId,
      deleted: error.notebookDeleted,
    };
  }
  return null;
}

/**
 * The server's message when another notebook already has the page, with a
 * way to it: a link to that notebook, or for a deleted one, Restore, which
 * brings it back and opens it.
 */
export function PageTakenNotice({
  conflict,
  onNavigate,
}: {
  conflict: PageTakenConflict;
  // Called before leaving for the other notebook, so a dialog can close.
  onNavigate?: () => void;
}) {
  const router = useRouter();
  const [isRestoring, startRestore] = useTransition();
  const href = notebookPageHref(conflict.notebookId);

  function restore() {
    startRestore(async () => {
      try {
        await restoreNotebook(conflict.notebookId);
      } catch (error) {
        // 409 means someone restored it first, which is what we wanted.
        if (!(error instanceof NotebookRequestError && error.status === 409)) {
          toast.error(
            error instanceof NotebookRequestError
              ? error.message
              : "Couldn't restore the notebook. Try again?"
          );
          return;
        }
      }
      toast.success("Notebook restored");
      onNavigate?.();
      router.push(href);
    });
  }

  return (
    <div
      className="flex flex-col gap-1.5 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm"
      role="alert"
    >
      <p className="text-destructive">{conflict.message}</p>
      {conflict.deleted ? (
        <button
          className="w-fit rounded-sm font-medium underline underline-offset-4 hover:text-foreground/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          disabled={isRestoring}
          onClick={restore}
          type="button"
        >
          {isRestoring ? "Restoring…" : "Restore notebook"}
        </button>
      ) : (
        <Link
          className="w-fit rounded-sm font-medium underline underline-offset-4 hover:text-foreground/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          href={href}
          onClick={onNavigate}
        >
          Open that notebook
        </Link>
      )}
    </div>
  );
}
