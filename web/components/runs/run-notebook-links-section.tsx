"use client";

import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { Fragment, useOptimistic, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  NotebookLinkForm,
  type NotebookLinkFormValues,
} from "@/components/runs/notebook-link-form";
import { NotebookLinkRow } from "@/components/runs/notebook-link-row";
import { RunSectionHeading } from "@/components/runs/run-section-heading";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import type { RunAttribution } from "@/lib/api/instrument-runs";
import type { NotebookLinkWire } from "@/lib/api/run-notebook-link-wire";
import { useSession } from "@/lib/auth-client";
import { toUserAvatarUser } from "@/lib/avatar-color";
import {
  notebookLinkDisplayName,
  parseNotebookLinkUrl,
} from "@/lib/notebook-links/url";
import { ownAttributionUrl } from "@/lib/runs/attribution-requests";
import {
  addNotebookLink,
  NotebookLinkRequestError,
  removeNotebookLink,
  updateNotebookLink,
} from "@/lib/runs/notebook-link-requests";

type Action =
  | { kind: "add"; link: NotebookLinkWire }
  | { kind: "update"; id: string; url: string; label: string | null }
  | { kind: "remove"; id: string };

function applyAction(
  links: NotebookLinkWire[],
  action: Action
): NotebookLinkWire[] {
  switch (action.kind) {
    case "add":
      return [...links, action.link];
    case "update":
      return links.map((link) =>
        link.id === action.id
          ? {
              ...link,
              url: action.url,
              label: action.label,
              display_name: notebookLinkDisplayName(action.url, action.label),
            }
          : link
      );
    case "remove":
      return links.filter((link) => link.id !== action.id);
    default:
      return links;
  }
}

function saveErrorMessage(error: unknown): string {
  if (error instanceof NotebookLinkRequestError) {
    if (error.linkId) {
      return "This run already links to that page.";
    }
    if (error.status === 400 || error.status === 409) {
      return error.message;
    }
  }
  return "Couldn't save the link. Try again?";
}

/**
 * The run page's "Lab notebook" section: the run's links to notebook pages,
 * with an inline form to add or edit one. Each change goes to the API and
 * then refreshes the page; the list shows the change right away and falls
 * back if the request fails.
 */
export function RunNotebookLinksSection({
  instrumentId,
  runId,
  links,
  attributions,
  isDeleted,
}: {
  instrumentId: string;
  runId: string;
  links: NotebookLinkWire[];
  attributions: RunAttribution[];
  isDeleted: boolean;
}) {
  const router = useRouter();
  const { data: session } = useSession();
  const [, startTransition] = useTransition();
  const [optimistic, dispatch] = useOptimistic(links, applyAction);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const run = { instrumentId, runId };
  const userId = session?.user?.id ?? null;
  const viewerRanIt =
    userId !== null && attributions.some((a) => a.userId === userId);

  // Runs `work` as a transition that ends with a page refresh, and resolves
  // with the error to show in the form, or null once it worked.
  function mutate(
    optimisticAction: Action,
    work: () => Promise<void>
  ): Promise<string | null> {
    return new Promise((resolve) => {
      startTransition(async () => {
        dispatch(optimisticAction);
        try {
          await work();
          resolve(null);
        } catch (error) {
          resolve(saveErrorMessage(error));
        } finally {
          router.refresh();
        }
      });
    });
  }

  function placeholderLink(values: NotebookLinkFormValues): NotebookLinkWire {
    const parsed = parseNotebookLinkUrl(values.url);
    const label = values.label === "" ? null : values.label;
    const now = new Date().toISOString();
    const me = session?.user
      ? toUserAvatarUser({
          userId: session.user.id,
          name: session.user.name,
          email: session.user.email,
          image: session.user.image,
        })
      : null;
    const user = me
      ? {
          id: me.userId,
          displayName: me.displayName,
          initials: me.initials,
          avatarUrl: me.avatarUrl,
        }
      : null;
    return {
      id: `temp-${crypto.randomUUID()}`,
      url: parsed?.url ?? values.url,
      url_key: parsed?.urlKey ?? values.url,
      label,
      display_name: notebookLinkDisplayName(values.url, label),
      created_at: now,
      created_by: user,
      created_by_token: null,
      updated_at: now,
      updated_by: user,
      updated_by_token: null,
    };
  }

  function handleAdd(values: NotebookLinkFormValues) {
    return mutate({ kind: "add", link: placeholderLink(values) }, async () => {
      await addNotebookLink(run, { url: values.url, label: values.label });
      setAdding(false);
      if (values.claim) {
        const res = await fetch(ownAttributionUrl(instrumentId, runId), {
          method: "PUT",
        }).catch(() => null);
        if (!res?.ok) {
          toast.error(
            "The link was added, but marking you as having run this didn't work. Try again from Ran By."
          );
        }
      }
    });
  }

  function handleUpdate(
    link: NotebookLinkWire,
    values: NotebookLinkFormValues
  ) {
    const label = values.label === "" ? null : values.label;
    return mutate(
      { kind: "update", id: link.id, url: values.url, label },
      async () => {
        await updateNotebookLink(run, link.id, {
          url: values.url,
          label: values.label,
        });
        setEditingId(null);
      }
    );
  }

  async function handleRemove(link: NotebookLinkWire): Promise<boolean> {
    // `ConfirmDialog` calls this inside its own transition.
    dispatch({ kind: "remove", id: link.id });
    try {
      await removeNotebookLink(run, link.id);
      return true;
    } catch {
      toast.error("Couldn't remove the link. Try again?");
      return false;
    } finally {
      router.refresh();
    }
  }

  const showAddButton = !(isDeleted || adding);

  return (
    <section aria-label="Lab notebook" className="flex flex-col gap-2">
      <RunSectionHeading
        actions={
          showAddButton ? (
            <Button
              onClick={() => {
                setEditingId(null);
                setAdding(true);
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              <Plus data-icon="inline-start" />
              Add link
            </Button>
          ) : undefined
        }
        countLabel={optimistic.length > 0 ? optimistic.length : undefined}
        title="Lab notebook"
      />
      <Card className="gap-0 py-0">
        {adding ? (
          <div className="px-4 py-3">
            <NotebookLinkForm
              claimLabel={viewerRanIt ? undefined : "I ran this run"}
              onCancel={() => setAdding(false)}
              onSave={handleAdd}
              variant="add"
            />
          </div>
        ) : null}
        {optimistic.length === 0 && !adding ? (
          <p className="px-4 py-3 text-muted-foreground text-sm">
            {isDeleted
              ? "This run has no lab notebook links."
              : "Link the lab notebook pages for this run, so whoever analyzes it can find the context."}
          </p>
        ) : null}
        {optimistic.map((link, index) => (
          <Fragment key={link.id}>
            {index > 0 || adding ? <Separator /> : null}
            {editingId === link.id ? (
              <div className="px-4 py-3">
                <NotebookLinkForm
                  initialLabel={link.label ?? ""}
                  initialUrl={link.url}
                  onCancel={() => setEditingId(null)}
                  onSave={(values) => handleUpdate(link, values)}
                  variant="edit"
                />
              </div>
            ) : (
              <NotebookLinkRow
                link={link}
                onEdit={() => {
                  setAdding(false);
                  setEditingId(link.id);
                }}
                onRemove={() => handleRemove(link)}
                readOnly={isDeleted || link.id.startsWith("temp-")}
              />
            )}
          </Fragment>
        ))}
      </Card>
    </section>
  );
}
