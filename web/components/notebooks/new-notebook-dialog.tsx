"use client";

import { Loader2, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useId, useRef, useState } from "react";
import { toast } from "sonner";
import {
  NotebookDescriptionField,
  NotebookLinkField,
  NotebookNameField,
  type PageTakenConflict,
  PageTakenNotice,
  pageTakenConflict,
} from "@/components/notebooks/notebook-fields";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { useUnsavedChangesWarning } from "@/hooks/use-unsaved-changes-warning";
import {
  type NotebookFieldErrors,
  notebookFieldErrors,
  notebookPageHref,
  suggestedNotebookName,
} from "@/lib/notebooks/details";
import {
  createNotebook,
  NotebookRequestError,
} from "@/lib/runs/notebook-requests";

/**
 * The "New lab notebook" button on `/lab-notebooks` and the dialog it opens: a link
 * to the notebook's page, a name worked out from the link until the person
 * types their own, an optional description, and the viewer as owner unless
 * they untick it. Saving opens the new notebook's page.
 */
export function NewNotebookDialog() {
  const [open, setOpen] = useState(false);

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        <Button className="gap-1.5" type="button">
          <Plus aria-hidden="true" className="size-4" />
          New lab notebook
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New lab notebook</DialogTitle>
          <DialogDescription>
            Paste the link to a lab notebook page, such as a Notion page. You
            can add runs to it from any runs table or run page.
          </DialogDescription>
        </DialogHeader>
        {/* Mounted only while open, so each opening starts blank. */}
        {open ? <NewNotebookForm onClose={() => setOpen(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function NewNotebookForm({ onClose }: { onClose: () => void }) {
  const id = useId();
  const router = useRouter();
  const urlRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);

  const [url, setUrl] = useState("");
  // What the person typed as the name. Until they type, the name follows
  // the link.
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [ownedByMe, setOwnedByMe] = useState(true);
  const [errors, setErrors] = useState<NotebookFieldErrors>({});
  const [conflict, setConflict] = useState<PageTakenConflict | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const name = nameDraft ?? suggestedNotebookName(url);

  useUnsavedChangesWarning(
    url.trim() !== "" || (nameDraft ?? "") !== "" || description.trim() !== ""
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) {
      return;
    }
    setConflict(null);
    setFormError(null);
    const found = notebookFieldErrors({ url, name, description });
    setErrors(found);
    if (found.url) {
      urlRef.current?.focus();
      return;
    }
    if (found.name) {
      nameRef.current?.focus();
      return;
    }
    if (found.description) {
      descriptionRef.current?.focus();
      return;
    }

    setSubmitting(true);
    try {
      const created = await createNotebook({
        url: url.trim(),
        name: name.trim(),
        description: description.trim() || undefined,
        ownedByMe,
      });
      toast.success(`Created “${created.lab_notebook.name}”`);
      onClose();
      router.push(notebookPageHref(created.lab_notebook.id));
    } catch (error) {
      setSubmitting(false);
      const taken = pageTakenConflict(error);
      if (taken) {
        setConflict(taken);
        return;
      }
      setFormError(
        error instanceof NotebookRequestError && error.status === 400
          ? error.message
          : "Couldn't create the lab notebook. Try again?"
      );
    }
  }

  return (
    <form className="flex flex-col gap-6" noValidate onSubmit={handleSubmit}>
      <div className="flex flex-col gap-4">
        <NotebookLinkField
          autoFocus
          error={errors.url}
          id={`${id}-url`}
          inputRef={urlRef}
          onChange={(value) => {
            setUrl(value);
            setConflict(null);
            setErrors((prev) => ({ ...prev, url: undefined }));
          }}
          value={url}
        />
        <NotebookNameField
          error={errors.name}
          hint={
            nameDraft === null && name !== ""
              ? "Taken from the link. Change it to anything."
              : undefined
          }
          id={`${id}-name`}
          inputRef={nameRef}
          onChange={(value) => {
            setNameDraft(value);
            setErrors((prev) => ({ ...prev, name: undefined }));
          }}
          value={name}
        />
        <NotebookDescriptionField
          error={errors.description}
          id={`${id}-description`}
          inputRef={descriptionRef}
          onChange={(value) => {
            setDescription(value);
            setErrors((prev) => ({ ...prev, description: undefined }));
          }}
          value={description}
        />
        <Field orientation="horizontal">
          <Checkbox
            checked={ownedByMe}
            id={`${id}-owner`}
            onCheckedChange={(checked) => setOwnedByMe(checked === true)}
          />
          <FieldLabel className="font-normal" htmlFor={`${id}-owner`}>
            Make me the owner
          </FieldLabel>
        </Field>
        {conflict ? (
          <PageTakenNotice conflict={conflict} onNavigate={onClose} />
        ) : null}
        {formError ? <FieldError>{formError}</FieldError> : null}
      </div>
      <DialogFooter>
        <Button
          disabled={submitting}
          onClick={onClose}
          type="button"
          variant="ghost"
        >
          Cancel
        </Button>
        <Button disabled={submitting} type="submit">
          {submitting ? (
            <Loader2 className="animate-spin" data-icon="inline-start" />
          ) : null}
          Create lab notebook
        </Button>
      </DialogFooter>
    </form>
  );
}
