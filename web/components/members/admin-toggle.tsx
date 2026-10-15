"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface AdminToggleProps {
  /**
   * Pre-resolved display label used in the success / error toasts so the
   * caller doesn't have to thread the user-row data into the toast
   * messages from the parent table cell.
   */
  displayName: string;
  /**
   * Current admin state, taken from the latest server render. The switch
   * only changes after the API call succeeds and `router.refresh()` loads
   * the new role.
   */
  isAdmin: boolean;
  /**
   * True when this row represents the signed-in user themselves. The
   * server-side PATCH rejects self-demotion with a 400; we disable the
   * switch here so the user never sees that failure path.
   */
  isSelf: boolean;
  userId: string;
}

export function AdminToggle({
  userId,
  isAdmin,
  isSelf,
  displayName,
}: AdminToggleProps) {
  const router = useRouter();
  // The role the user asked for, held until they confirm. The switch keeps
  // showing the saved role, so cancelling leaves nothing to undo. The request
  // stays set while the dialog fades out so its text doesn't change.
  const [requested, setRequested] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function applyRole(next: boolean): Promise<boolean> {
    try {
      const res = await fetch(`/api/v1/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_admin: next }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(
          body?.error?.message ??
            "Couldn't update the member's role. Try again."
        );
        return false;
      }
    } catch {
      toast.error(
        "Couldn't update the member's role. Check your connection and try again."
      );
      return false;
    }

    toast.success(
      next
        ? `${displayName} is now an admin`
        : `${displayName} is no longer an admin`
    );
    router.refresh();
    return true;
  }

  const control = (
    <>
      <Switch
        aria-label={
          isAdmin
            ? `Revoke admin access for ${displayName}`
            : `Grant admin access to ${displayName}`
        }
        checked={isAdmin}
        disabled={isSelf}
        onCheckedChange={(next) => {
          setRequested(next);
          setConfirming(true);
        }}
      />
      <ConfirmDialog
        confirmLabel={requested ? "Make Admin" : "Remove Admin Access"}
        description={
          requested
            ? "Admins can create and revoke access tokens, change other members' roles, manage integrations, and update instruments."
            : `${displayName} will no longer be able to create or revoke access tokens, change roles, or manage integrations.`
        }
        destructive={!requested}
        onConfirm={() => applyRole(requested)}
        onOpenChange={setConfirming}
        open={confirming}
        title={
          requested
            ? `Make ${displayName} an admin?`
            : `Remove admin access for ${displayName}?`
        }
      />
    </>
  );

  if (!isSelf) {
    return control;
  }

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
