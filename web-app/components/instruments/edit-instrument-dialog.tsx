"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import { Loader2, Pencil } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

const INSTRUMENT_TYPE_OPTIONS = [
  { value: "generic", label: "Generic" },
  { value: "plate_reader", label: "Plate Reader" },
] as const;

export function EditInstrumentDialog({
  instrumentId,
  displayName,
  filePatterns,
  instrumentType,
}: {
  instrumentId: string;
  displayName: string;
  filePatterns: string[];
  instrumentType: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(displayName);
  const [patterns, setPatterns] = useState(filePatterns.join(", "));
  const [type, setType] = useState(instrumentType);
  const [isPending, startTransition] = useTransition();

  function handleSave() {
    startTransition(async () => {
      const parsedPatterns = patterns
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);

      const res = await fetch(`/api/v1/instruments/${instrumentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          display_name: name.trim(),
          file_patterns: parsedPatterns,
          instrument_type: type,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(body?.error ?? "Failed to update instrument");
        return;
      }

      toast.success("Instrument updated");
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        // Re-sync form state from props on open so the dialog reflects any
        // server-side changes since the last time it was opened.
        if (value) {
          setName(displayName);
          setPatterns(filePatterns.join(", "));
          setType(instrumentType);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
          <Pencil className="size-3.5" />
          <span className="sr-only">Edit instrument</span>
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit instrument</DialogTitle>
          <DialogDescription>
            Update the display name or file patterns for{" "}
            <span className="font-mono">{instrumentId}</span>.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="edit-name">Display name</Label>
            <Input
              id="edit-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              autoFocus
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="edit-patterns">File patterns</Label>
            <Input
              id="edit-patterns"
              placeholder="e.g. *.xls, *.csv"
              value={patterns}
              onChange={(e) => setPatterns(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Comma-separated glob patterns.
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="edit-type">Instrument type</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger id="edit-type" className="w-full">
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
            <p className="text-xs text-muted-foreground">
              Controls the run detail page layout.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={handleSave} disabled={!name.trim() || isPending}>
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
