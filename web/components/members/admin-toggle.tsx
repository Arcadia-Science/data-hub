"use client";

import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";

type AdminToggleProps = {
  userId: string;
  /**
   * Current admin state, taken from the latest server render. The switch
   * is uncontrolled with respect to local UI state — the optimistic flip
   * happens via `router.refresh()` after the API call succeeds.
   */
  isAdmin: boolean;
  /**
   * True when this row represents the signed-in user themselves. The
   * server-side PATCH rejects self-demotion with a 400; we disable the
   * switch here so the user never sees that failure path.
   */
  isSelf: boolean;
  /**
   * Pre-resolved display label used in the success / error toasts so the
   * caller doesn't have to thread the user-row data into the toast
   * messages from the parent table cell.
   */
  displayName: string;
};

export function AdminToggle({
  userId,
  isAdmin,
  isSelf,
  displayName,
}: AdminToggleProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const handleChange = (next: boolean) => {
    startTransition(async () => {
      const res = await fetch(`/api/v1/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_admin: next }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(
          body?.error?.message ??
            body?.error ??
            "Failed to update member's role"
        );
        return;
      }

      toast.success(
        next
          ? `${displayName} is now an admin`
          : `${displayName} is no longer an admin`
      );
      router.refresh();
    });
  };

  const control = (
    <div className="flex items-center gap-2">
      {isPending ? (
        <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
      ) : null}
      <Switch
        checked={isAdmin}
        disabled={isSelf || isPending}
        onCheckedChange={handleChange}
        aria-label={isAdmin ? "Revoke admin" : "Grant admin"}
      />
    </div>
  );

  if (!isSelf) return control;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{control}</span>
      </TooltipTrigger>
      <TooltipContent>
        Admins can&apos;t demote themselves. Ask another admin.
      </TooltipContent>
    </Tooltip>
  );
}
