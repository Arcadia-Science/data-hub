"use client";

import { Link2 } from "lucide-react";
import { toast } from "sonner";
import { changelogEntryPath } from "@/lib/changelog/href";

export function CopyEntryLinkButton({
  entryId,
  title,
}: {
  entryId: string;
  title: string;
}) {
  async function copyLink() {
    const url = `${window.location.origin}${changelogEntryPath(entryId)}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied");
    } catch {
      toast.error("Couldn’t copy the link");
    }
  }

  return (
    <button
      aria-label={`Copy link to ${title}`}
      className="inline-flex min-h-8 cursor-pointer items-center gap-1.5 font-medium text-foreground text-sm"
      onClick={copyLink}
      type="button"
    >
      <Link2 aria-hidden="true" className="size-[15px] text-muted-foreground" />
      <span className="underline decoration-neutral-400 underline-offset-[3px]">
        Copy link
      </span>
    </button>
  );
}
