"use client";

import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";

export function DeleteTokenDialog({
  tokenId,
  tokenName,
}: {
  tokenId: string;
  tokenName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  async function handleDelete(): Promise<boolean> {
    try {
      const res = await fetch(`/api/v1/tokens/${tokenId}`, {
        method: "DELETE",
      });
      if (!(res.ok || res.status === 204)) {
        toast.error("Couldn't delete the token. Try again.");
        return false;
      }
    } catch {
      toast.error(
        "Couldn't delete the token. Check your connection and try again."
      );
      return false;
    }
    toast.success(`Token "${tokenName}" deleted`);
    router.refresh();
    return true;
  }

  return (
    <>
      <Button
        aria-label={`Delete token ${tokenName}`}
        onClick={() => setOpen(true)}
        size="icon-sm"
        variant="ghost"
      >
        <Trash2 aria-hidden="true" className="size-4 text-muted-foreground" />
      </Button>
      <ConfirmDialog
        confirmLabel="Delete Token"
        description={
          <>
            Are you sure you want to delete{" "}
            <span className="font-medium text-foreground">{tokenName}</span>?
            Any tools using this token will lose access immediately.
          </>
        }
        onConfirm={handleDelete}
        onOpenChange={setOpen}
        open={open}
        title="Delete access token"
        variant="destructive"
      />
    </>
  );
}
