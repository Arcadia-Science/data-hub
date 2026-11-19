"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, type RefObject, useId, useRef, useState } from "react";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useUnsavedChangesWarning } from "@/hooks/use-unsaved-changes-warning";
import type { NotebookWire } from "@/lib/api/notebook-wire";
import {
  initialOwnerChoice,
  type NotebookFieldErrors,
  notebookEditPatch,
  notebookFieldErrors,
  type OwnerChoice,
} from "@/lib/notebooks/details";
import {
  NotebookRequestError,
  updateNotebook,
} from "@/lib/runs/notebook-requests";

function isOwnerChoice(value: string): value is OwnerChoice {
  return value === "me" || value === "current" || value === "none";
}

/**
 * Edits a notebook's name, description, owner, and link. Opened from the
 * notebook page's ⋯ menu, so on close it puts focus back on the menu's
 * button (`returnFocusRef`) instead of the menu item, which is gone by then.
 */
export function EditNotebookDialog({
  notebook,
  viewerId,
  open,
  onOpenChange,
  returnFocusRef,
}: {
  notebook: NotebookWire;
  viewerId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        onCloseAutoFocus={(event) => {
          const target = returnFocusRef.current;
          if (target?.isConnected) {
            event.preventDefault();
            target.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Edit details</DialogTitle>
          <DialogDescription>
            Change the lab notebook&rsquo;s name, description, owner, or link.
            Its runs stay in it.
          </DialogDescription>
        </DialogHeader>
        {/* Mounted only while open, so each opening starts from the
            notebook as it is now. */}
        {open ? (
          <EditNotebookForm
            notebook={notebook}
            onClose={() => onOpenChange(false)}
            viewerId={viewerId}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function EditNotebookForm({
  notebook,
  viewerId,
  onClose,
}: {
  notebook: NotebookWire;
  viewerId: string;
  onClose: () => void;
}) {
  const id = useId();
  const router = useRouter();
  const nameRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);

  const initial = {
    name: notebook.name,
    description: notebook.description,
    url: notebook.url,
    owner: initialOwnerChoice(notebook.owner?.id ?? null, viewerId),
  };
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description ?? "");
  const [url, setUrl] = useState(initial.url);
  const [owner, setOwner] = useState<OwnerChoice>(initial.owner);
  const [errors, setErrors] = useState<NotebookFieldErrors>({});
  const [conflict, setConflict] = useState<PageTakenConflict | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const patch = notebookEditPatch(initial, { name, description, url, owner });
  const changed = Object.keys(patch).length > 0;
  useUnsavedChangesWarning(changed);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) {
      return;
    }
    setConflict(null);
    setFormError(null);
    const found = notebookFieldErrors({ url, name, description });
    setErrors(found);
    if (found.name) {
      nameRef.current?.focus();
      return;
    }
    if (found.description) {
      descriptionRef.current?.focus();
      return;
    }
    if (found.url) {
      urlRef.current?.focus();
      return;
    }
    if (!changed) {
      onClose();
      return;
    }

    setSubmitting(true);
    try {
      await updateNotebook(notebook.id, patch);
    } catch (error) {
      setSubmitting(false);
      const taken = pageTakenConflict(error);
      if (taken) {
        setConflict(taken);
        return;
      }
      setFormError(
        error instanceof NotebookRequestError &&
          (error.status === 400 || error.status === 404 || error.status === 409)
          ? error.message
          : "Couldn't save the changes. Try again?"
      );
      return;
    }
    toast.success("Lab notebook updated");
    onClose();
    router.refresh();
  }

  return (
    <form className="flex flex-col gap-6" noValidate onSubmit={handleSubmit}>
      <div className="flex flex-col gap-4">
        <NotebookNameField
          error={errors.name}
          id={`${id}-name`}
          inputRef={nameRef}
          onChange={(value) => {
            setName(value);
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
        <Field>
          <FieldLabel htmlFor={`${id}-owner`}>Owner</FieldLabel>
          <Select
            onValueChange={(value) => {
              if (isOwnerChoice(value)) {
                setOwner(value);
              }
            }}
            value={owner}
          >
            <SelectTrigger
              className="w-full data-[size=default]:h-9"
              id={`${id}-owner`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {initial.owner === "current" && notebook.owner ? (
                <SelectItem value="current">
                  {notebook.owner.displayName}
                </SelectItem>
              ) : null}
              <SelectItem value="me">You</SelectItem>
              <SelectItem value="none">No owner</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <NotebookLinkField
          error={errors.url}
          hint="No other lab notebook can have the same page."
          id={`${id}-url`}
          inputRef={urlRef}
          onChange={(value) => {
            setUrl(value);
            setConflict(null);
            setErrors((prev) => ({ ...prev, url: undefined }));
          }}
          value={url}
        />
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
          Save changes
        </Button>
      </DialogFooter>
    </form>
  );
}
