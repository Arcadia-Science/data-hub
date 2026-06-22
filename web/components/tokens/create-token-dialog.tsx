"use client";

import { Loader2, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { ALL_SCOPES, type Scope } from "@/lib/api/scopes";

// Lifted dialog state: the form and success bodies are sibling components
// that never share state across the boundary, so the parent only tracks the
// modal's view via a discriminated union. The plaintext token lives only
// inside the success branch — it's structurally absent during the form
// phase, which makes "show plaintext while filling out the form" a type
// error rather than a runtime bug.
type View = { kind: "form" } | { kind: "success"; plaintext: string };

const EXPIRY_PRESETS = [
  { label: "30 days", value: "30" },
  { label: "90 days", value: "90" },
  { label: "1 year", value: "365" },
  { label: "No expiry", value: "none" },
] as const;

function computeExpiresAt(days: string): string | undefined {
  if (days === "none") {
    return;
  }
  const d = new Date();
  d.setDate(d.getDate() + Number.parseInt(days, 10));
  return d.toISOString();
}

// Resource → [read, write] grid order. Derived from ALL_SCOPES so adding a
// new scope automatically surfaces in the picker. Tokens API rejects "*"
// from callers, so it's intentionally absent here.
type ResourceRow = {
  resource: string;
  read?: Scope;
  write?: Scope;
};

function buildResourceRows(): ResourceRow[] {
  const byResource = new Map<string, ResourceRow>();
  for (const scope of ALL_SCOPES) {
    const [resource, action] = scope.split(":") as [string, "read" | "write"];
    const row = byResource.get(resource) ?? { resource };
    row[action] = scope;
    byResource.set(resource, row);
  }
  return Array.from(byResource.values());
}

export function CreateTokenDialog() {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>({ kind: "form" });

  // Discriminated `view` controls the body: `"form"` while creating, then
  // flipping to `{ kind: "success", plaintext }` once the API responds.
  // No `step` boolean, no shared plaintext state — `plaintext` exists only
  // in the success branch.
  return (
    <Dialog
      onOpenChange={(value) => {
        // Block dismissal while the plaintext is shown — the token can never
        // be retrieved again, so the user must explicitly click "Done".
        if (!value && view.kind === "success") {
          return;
        }
        setOpen(value);
        if (!value) {
          setView({ kind: "form" });
        }
      }}
      open={open}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus data-icon="inline-start" />
          Create token
        </Button>
      </DialogTrigger>
      <DialogContent
        onEscapeKeyDown={(e) => {
          if (view.kind === "success") {
            e.preventDefault();
          }
        }}
        onPointerDownOutside={(e) => {
          if (view.kind === "success") {
            e.preventDefault();
          }
        }}
      >
        {view.kind === "form" ? (
          <CreateTokenForm
            onCreated={(plaintext) => setView({ kind: "success", plaintext })}
          />
        ) : (
          <CreateTokenSuccess
            onDone={() => {
              setOpen(false);
              setView({ kind: "form" });
            }}
            plaintext={view.plaintext}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function CreateTokenForm({
  onCreated,
}: {
  onCreated: (plaintext: string) => void;
}) {
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState("90");
  const [selected, setSelected] = useState<Set<Scope>>(() => new Set());
  const [isPending, startTransition] = useTransition();

  // ALL_SCOPES is module-level constant, so the grid is stable across
  // renders — memoising the build avoids re-grouping on every keystroke.
  const resourceRows = useMemo(() => buildResourceRows(), []);

  // Functional setState so the handler identity stays stable across
  // renders; the Checkbox subtree can rely on Object.is to skip re-render.
  const toggle = useCallback((s: Scope) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(s)) {
        next.delete(s);
      } else {
        next.add(s);
      }
      return next;
    });
  }, []);

  // Disabled state is derived inline from the inputs — no extra `useState`
  // mirror, no effect to keep them in sync.
  const canSubmit = Boolean(name.trim()) && selected.size > 0 && !isPending;

  const handleCreate = () => {
    startTransition(async () => {
      const expiresAt = computeExpiresAt(expiry);
      const res = await fetch("/api/v1/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          expires_at: expiresAt,
          scopes: Array.from(selected),
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(body?.error?.message ?? "Failed to create token");
        return;
      }

      const data = await res.json();
      onCreated(data.token);
    });
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Create access token</DialogTitle>
        <DialogDescription>
          Tokens are used to authenticate API requests from external tools.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-4 py-2">
        <div className="grid gap-2">
          <Label htmlFor="token-name">Name</Label>
          <Input
            autoFocus
            id="token-name"
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Plate Reader PC"
            value={name}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="token-expiry">Expiration</Label>
          <Select onValueChange={setExpiry} value={expiry}>
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
        <div className="grid gap-2">
          <Label>Scopes</Label>
          <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-4 gap-y-2 rounded-md border bg-background px-3 py-2 dark:bg-muted">
            <div className="font-medium text-muted-foreground text-xs">
              Resource
            </div>
            <div className="w-14 text-center font-medium text-muted-foreground text-xs">
              Read
            </div>
            <div className="w-14 text-center font-medium text-muted-foreground text-xs">
              Write
            </div>
            {resourceRows.map((row) => (
              <ScopeRow
                key={row.resource}
                onToggle={toggle}
                row={row}
                selected={selected}
              />
            ))}
          </div>
          <p className="text-muted-foreground text-xs">
            Pick the minimum scopes this token needs. You can&apos;t change them
            after creation — revoke and re-issue instead.
          </p>
        </div>
      </div>
      <DialogFooter>
        <Button disabled={!canSubmit} onClick={handleCreate}>
          {isPending ? (
            <Loader2 className="animate-spin" data-icon="inline-start" />
          ) : null}
          Create token
        </Button>
      </DialogFooter>
    </>
  );
}

function ScopeRow({
  row,
  selected,
  onToggle,
}: {
  row: ResourceRow;
  selected: Set<Scope>;
  onToggle: (s: Scope) => void;
}) {
  return (
    <>
      <div className="text-sm">{row.resource}</div>
      <div className="flex w-14 justify-center">
        {row.read ? (
          <Checkbox
            aria-label={row.read}
            checked={selected.has(row.read)}
            id={`scope-${row.read}`}
            onCheckedChange={() => onToggle(row.read as Scope)}
          />
        ) : (
          <span className="text-muted-foreground/40 text-xs">—</span>
        )}
      </div>
      <div className="flex w-14 justify-center">
        {row.write ? (
          <Checkbox
            aria-label={row.write}
            checked={selected.has(row.write)}
            id={`scope-${row.write}`}
            onCheckedChange={() => onToggle(row.write as Scope)}
          />
        ) : (
          <span className="text-muted-foreground/40 text-xs">—</span>
        )}
      </div>
    </>
  );
}

function CreateTokenSuccess({
  plaintext,
  onDone,
}: {
  plaintext: string;
  onDone: () => void;
}) {
  const router = useRouter();
  const handleDone = () => {
    onDone();
    router.refresh();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Token created</DialogTitle>
        <DialogDescription>
          Make sure to copy your token now. You won&apos;t be able to see it
          again.
        </DialogDescription>
      </DialogHeader>
      <div className="min-w-0 py-2">
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 overflow-x-hidden rounded-md border bg-muted px-3 py-2 font-mono text-sm">
            {plaintext}
          </code>
          <CopyButton value={plaintext} />
        </div>
      </div>
      <DialogFooter>
        <Button onClick={handleDone}>Done</Button>
      </DialogFooter>
    </>
  );
}
