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
import { Check, Copy, Loader2, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useState, useTransition } from "react";

type Step = "form" | "display";

const EXPIRY_PRESETS = [
  { label: "30 days", value: "30" },
  { label: "90 days", value: "90" },
  { label: "1 year", value: "365" },
  { label: "No expiry", value: "none" },
] as const;

function computeExpiresAt(days: string): string | undefined {
  if (days === "none") return undefined;
  const d = new Date();
  d.setDate(d.getDate() + parseInt(days, 10));
  return d.toISOString();
}

export function CreateTokenDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("form");
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState("90");
  const [isPending, startTransition] = useTransition();
  const [plaintext, setPlaintext] = useState("");
  const [copied, setCopied] = useState(false);

  const reset = useCallback(() => {
    setStep("form");
    setName("");
    setExpiry("90");
    setPlaintext("");
    setCopied(false);
  }, []);

  const handleCreate = () => {
    startTransition(async () => {
      const expiresAt = computeExpiresAt(expiry);
      const res = await fetch("/api/v1/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          expires_at: expiresAt,
        }),
      });

      if (!res.ok) {
        return;
      }

      const data = await res.json();
      setPlaintext(data.token);
      setStep("display");
    });
  };

  const handleCopy = async () => {
    await navigator.clipboard.writeText(plaintext);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDone = () => {
    setOpen(false);
    reset();
    router.refresh();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value && step === "display") return;
        setOpen(value);
        if (!value) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus data-icon="inline-start" />
          Create token
        </Button>
      </DialogTrigger>
      <DialogContent
        onPointerDownOutside={(e) => {
          if (step === "display") e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (step === "display") e.preventDefault();
        }}
      >
        {step === "form" ? (
          <>
            <DialogHeader>
              <DialogTitle>Create access token</DialogTitle>
              <DialogDescription>
                Tokens are used to authenticate API requests from external
                tools.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-2">
              <div className="grid gap-2">
                <Label htmlFor="token-name">Name</Label>
                <Input
                  id="token-name"
                  placeholder="e.g. Plate Reader PC"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={100}
                  autoFocus
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="token-expiry">Expiration</Label>
                <Select value={expiry} onValueChange={setExpiry}>
                  <SelectTrigger id="token-expiry">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EXPIRY_PRESETS.map((preset) => (
                      <SelectItem key={preset.value} value={preset.value}>
                        {preset.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button
                onClick={handleCreate}
                disabled={!name.trim() || isPending}
              >
                {isPending ? (
                  <Loader2 className="animate-spin" data-icon="inline-start" />
                ) : null}
                Create token
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Token created</DialogTitle>
              <DialogDescription>
                Make sure to copy your token now. You won&apos;t be able to see
                it again.
              </DialogDescription>
            </DialogHeader>
            <div className="min-w-0 py-2">
              <div className="flex items-center gap-2">
                <code className="overflow-x-hidden min-w-0 flex-1 rounded-md border bg-muted px-3 py-2 font-mono text-sm">
                  {plaintext}
                </code>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handleCopy}
                  aria-label="Copy token"
                >
                  {copied ? (
                    <Check className="size-4" />
                  ) : (
                    <Copy className="size-4" />
                  )}
                </Button>
              </div>
            </div>
            <DialogFooter>
              <Button onClick={handleDone}>Done</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
