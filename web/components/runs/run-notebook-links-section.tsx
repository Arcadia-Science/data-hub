"use client";

import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  Fragment,
  useEffect,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from "react";
import { toast } from "sonner";
import { NotebookLinkRow } from "@/components/runs/notebook-link-row";
import {
  NotebookPickerForm,
  type NotebookPickerValues,
} from "@/components/runs/notebook-picker-form";
import { RunSectionHeading } from "@/components/runs/run-section-heading";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import type { RunAttribution } from "@/lib/api/instrument-runs";
import type { RunNotebookWire } from "@/lib/api/notebook-wire";
import { useSession } from "@/lib/auth-client";
import { toUserAvatarUser } from "@/lib/avatar-color";
import { ownAttributionUrl } from "@/lib/runs/attribution-requests";
import { addRunError } from "@/lib/runs/notebook-outcomes";
import {
  addRunsToPick,
  type NotebookPick,
  NotebookRequestError,
  removeRunsFromNotebook,
} from "@/lib/runs/notebook-requests";

type Action =
  | { kind: "add"; notebook: RunNotebookWire }
  | { kind: "remove"; id: string };

function applyAction(
  notebooks: RunNotebookWire[],
  action: Action
): RunNotebookWire[] {
  switch (action.kind) {
    case "add":
      return notebooks.some((notebook) => notebook.id === action.notebook.id)
        ? notebooks
        : [...notebooks, action.notebook];
    case "remove":
      return notebooks.filter((notebook) => notebook.id !== action.id);
    default:
      return notebooks;
  }
}

function saveErrorMessage(error: unknown): string {
  if (
    error instanceof NotebookRequestError &&
    (error.status === 400 || error.status === 409)
  ) {
    return error.message;
  }
  return "Couldn't add the run. Try again?";
}

/**
 * The run page's "Lab notebooks" section: the notebooks the run is in, with
 * an inline picker to add it to another. Each change goes to the API and
 * then refreshes the page; the list shows the change right away and falls
 * back if the request fails.
 */
export function RunNotebookLinksSection({
  instrumentId,
  runId,
  notebooks,
  attributions,
  isDeleted,
}: {
  instrumentId: string;
  runId: string;
  notebooks: RunNotebookWire[];
  attributions: RunAttribution[];
  isDeleted: boolean;
}) {
  const router = useRouter();
  const { data: session } = useSession();
  const [, startTransition] = useTransition();
  const [optimistic, dispatch] = useOptimistic(notebooks, applyAction);
  const [adding, setAdding] = useState(false);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  // Set when the picker closes, so focus goes back to the Add button once
  // it's on screen again instead of dropping to the page.
  const returnFocusRef = useRef(false);

  useEffect(() => {
    if (!adding && returnFocusRef.current) {
      returnFocusRef.current = false;
      addButtonRef.current?.focus();
    }
  }, [adding]);

  const run = { instrumentId, runId };
  const userId = session?.user?.id ?? null;
  const viewerRanIt =
    userId !== null && attributions.some((a) => a.userId === userId);

  function closePicker() {
    returnFocusRef.current = true;
    setAdding(false);
  }

  function placeholderNotebook(pick: NotebookPick): RunNotebookWire {
    const me = session?.user
      ? toUserAvatarUser({
          userId: session.user.id,
          name: session.user.name,
          email: session.user.email,
          image: session.user.image,
        })
      : null;
    const notebook =
      pick.kind === "create"
        ? { id: `temp-${crypto.randomUUID()}`, name: pick.name, url: pick.url }
        : pick.notebook;
    return {
      id: notebook.id,
      name: notebook.name,
      url: notebook.url,
      url_key: notebook.url,
      linked_at: new Date().toISOString(),
      linked_by: me
        ? {
            id: me.userId,
            displayName: me.displayName,
            initials: me.initials,
            avatarUrl: me.avatarUrl,
          }
        : null,
      linked_by_token: null,
    };
  }

  // Adds the run as a transition that ends with a page refresh, and resolves
  // with the error to show in the picker, or null once it worked.
  function handleAdd(
    pick: NotebookPick,
    values: NotebookPickerValues
  ): Promise<string | null> {
    return new Promise((resolve) => {
      startTransition(async () => {
        dispatch({ kind: "add", notebook: placeholderNotebook(pick) });
        try {
          const { result } = await addRunsToPick(pick, [run]);
          const error = addRunError(result.results[0]?.outcome);
          if (error) {
            resolve(error);
            return;
          }
          closePicker();
          if (values.claim) {
            const res = await fetch(ownAttributionUrl(instrumentId, runId), {
              method: "PUT",
            }).catch(() => null);
            if (!res?.ok) {
              toast.error(
                "The run was added to the notebook, but marking you as having run it didn't work. Try again from Ran By."
              );
            }
          }
          resolve(null);
        } catch (error) {
          resolve(saveErrorMessage(error));
        } finally {
          router.refresh();
        }
      });
    });
  }

  async function handleRemove(notebook: RunNotebookWire): Promise<boolean> {
    // `ConfirmDialog` calls this inside its own transition.
    dispatch({ kind: "remove", id: notebook.id });
    try {
      const result = await removeRunsFromNotebook(notebook.id, [run]);
      const outcome = result.results[0]?.outcome;
      if (outcome === "run_deleted" || outcome === "not_found") {
        toast.error("Couldn't remove the run from the notebook.");
        return false;
      }
      return true;
    } catch (error) {
      // The notebook is gone, so the run isn't in it anymore.
      if (error instanceof NotebookRequestError && error.status === 404) {
        return true;
      }
      toast.error("Couldn't remove the run from the notebook. Try again?");
      return false;
    } finally {
      router.refresh();
    }
  }

  const showAddButton = !(isDeleted || adding);

  return (
    <section aria-label="Lab notebooks" className="flex flex-col gap-2">
      <RunSectionHeading
        actions={
          showAddButton ? (
            <Button
              onClick={() => setAdding(true)}
              ref={addButtonRef}
              size="sm"
              type="button"
              variant="outline"
            >
              <Plus data-icon="inline-start" />
              Add to notebook
            </Button>
          ) : undefined
        }
        countLabel={optimistic.length > 0 ? optimistic.length : undefined}
        title="Lab notebooks"
      />
      <Card className="gap-0 py-0">
        {adding ? (
          <div className="px-4 py-3">
            <NotebookPickerForm
              claimLabel={viewerRanIt ? undefined : "I ran this run"}
              onCancel={closePicker}
              onSave={handleAdd}
              runNotebookIds={[notebooks.map((notebook) => notebook.id)]}
            />
          </div>
        ) : null}
        {optimistic.length === 0 && !adding ? (
          <p className="px-4 py-3 text-muted-foreground text-sm">
            {isDeleted
              ? "This run isn't in any lab notebook."
              : "Add this run to the lab notebooks that describe it, so whoever analyzes it can find the context."}
          </p>
        ) : null}
        {optimistic.map((notebook, index) => (
          <Fragment key={notebook.id}>
            {index > 0 || adding ? <Separator /> : null}
            <NotebookLinkRow
              notebook={notebook}
              onRemove={() => handleRemove(notebook)}
              // A row still being added has nothing to remove yet.
              readOnly={
                isDeleted ||
                !notebooks.some((saved) => saved.id === notebook.id)
              }
            />
          </Fragment>
        ))}
      </Card>
    </section>
  );
}
