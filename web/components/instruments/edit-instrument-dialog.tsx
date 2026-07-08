"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { VALID_INSTRUMENT_TYPES } from "@/lib/db/schema";

const TYPE_LABELS: Record<string, string> = {
  generic: "Generic",
  plate_reader: "Plate Reader",
  gel_doc: "Gel Doc",
  qpcr: "qPCR",
  tape_station: "TapeStation",
  hina_microscope: "Hina Microscope",
  epson_v700_scanner: "Epson V700 Scanner",
  instant_raman: "InstantRaman",
};

const INSTRUMENT_TYPE_OPTIONS = VALID_INSTRUMENT_TYPES.map((value) => ({
  value,
  label: TYPE_LABELS[value] ?? value,
}));

export function EditInstrumentDialog({
  instrumentId,
  displayName,
  instrumentType,
  open,
  onOpenChange,
}: {
  instrumentId: string;
  displayName: string;
  instrumentType: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(displayName);
  const [type, setType] = useState(instrumentType);
  const [isPending, startTransition] = useTransition();

  // Re-sync form state from props whenever the dialog opens so it reflects any
  // server-side changes since the last edit. The dialog is opened
  // programmatically by its parent menu, so `onOpenChange` alone wouldn't fire.
  useEffect(() => {
    if (open) {
      setName(displayName);
      setType(instrumentType);
    }
  }, [open, displayName, instrumentType]);

  // Disable Save until the user actually changes something — comparing the
  // trimmed name avoids treating whitespace-only edits as a real change.
  const isUnchanged =
    name.trim() === displayName.trim() && type === instrumentType;

  function handleSave() {
    startTransition(async () => {
      const res = await fetch(`/api/v1/instruments/${instrumentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          display_name: name.trim(),
          instrument_type: type,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(body?.error ?? "Failed to update instrument");
        return;
      }

      toast.success("Instrument updated");
      onOpenChange(false);
      router.refresh();
    });
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit instrument</DialogTitle>
          <DialogDescription>
            Update the display name or type for{" "}
            <span className="font-mono">{instrumentId}</span>.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="edit-name">Display name</Label>
            <Input
              autoFocus
              id="edit-name"
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
              value={name}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="edit-type">Instrument type</Label>
            <Select onValueChange={setType} value={type}>
              <SelectTrigger className="w-full" id="edit-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INSTRUMENT_TYPE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              Controls the run detail page layout.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button
            disabled={!name.trim() || isUnchanged || isPending}
            onClick={handleSave}
          >
            {isPending && (
              <Loader2 className="animate-spin" data-icon="inline-start" />
            )}
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
