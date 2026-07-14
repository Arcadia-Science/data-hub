"use client";

import { ChevronsUpDown, Loader2, Plus, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useTransition,
} from "react";
import { toast } from "sonner";
import { CopyButton } from "@/components/copy-button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { SCOPE_METADATA, SCOPE_PRESETS } from "@/lib/api/scope-catalog";
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

// Scopes are `resource:action`; `:read` is the sole read action per resource.
const READ_SCOPES = ALL_SCOPES.filter((s) => s.endsWith(":read"));
const WRITE_SCOPES = ALL_SCOPES.filter((s) => !s.endsWith(":read"));

interface ResourceGroup {
  resource: string;
  scopes: Scope[];
}

interface WorkspaceUser {
  email: string | null;
  id: string;
  name: string | null;
}

// Group scopes by resource, preserving ALL_SCOPES order so the grid layout is
// deterministic and adding a scope surfaces automatically.
function groupScopesByResource(): ResourceGroup[] {
  const byResource = new Map<string, Scope[]>();
  for (const scope of ALL_SCOPES) {
    const [resource] = scope.split(":") as [string];
    const list = byResource.get(resource) ?? [];
    list.push(scope);
    byResource.set(resource, list);
  }
  return Array.from(byResource, ([resource, scopes]) => ({ resource, scopes }));
}

function setsEqual(a: Set<Scope>, b: readonly Scope[]): boolean {
  return a.size === b.length && b.every((s) => a.has(s));
}

function computeExpiresAt(days: string): string | undefined {
  if (days === "none") {
    return;
  }
  const d = new Date();
  d.setDate(d.getDate() + Number.parseInt(days, 10));
  return d.toISOString();
}

function userLabel(user: WorkspaceUser): string {
  return user.name ?? user.email ?? user.id;
}

export function CreateTokenDialog({
  currentUserId,
}: {
  currentUserId: string;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>({ kind: "form" });

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
        className="max-h-[90vh] overflow-y-auto sm:max-w-lg"
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
            currentUserId={currentUserId}
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
  currentUserId,
  onCreated,
}: {
  currentUserId: string;
  onCreated: (plaintext: string) => void;
}) {
  const [name, setName] = useState("");
  const [ownerId, setOwnerId] = useState(currentUserId);
  const [users, setUsers] = useState<WorkspaceUser[] | null>(null);
  const [usersError, setUsersError] = useState(false);
  const [expiry, setExpiry] = useState("90");
  const [selected, setSelected] = useState<Set<Scope>>(() => new Set());
  const [customOpen, setCustomOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  // Lazy-load the roster when the form mounts (dialog opened), not on the
  // tokens page itself — most visits are audits, not mints.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/v1/users")
      .then((res) => {
        if (!res.ok) {
          throw new Error("Failed to load users");
        }
        return res.json() as Promise<WorkspaceUser[]>;
      })
      .then((rows) => {
        if (!cancelled) {
          setUsers(rows);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setUsersError(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const groups = useMemo(groupScopesByResource, []);

  // Which preset (if any) the current selection matches. Derived during
  // render so preset highlighting can't drift out of sync with the boxes.
  const activePresetId = useMemo(() => {
    const match = SCOPE_PRESETS.find((p) => setsEqual(selected, p.scopes));
    return match?.id ?? null;
  }, [selected]);

  // Resources that have a write-type scope selected but not their `:read`.
  // Scopes stay atomic (write never implies read), so this is a common
  // footgun for interactive tooling — surface it as a soft warning. It is
  // suppressed for exact preset matches below: machine presets (Watcher,
  // Lambda) legitimately write resources they never GET.
  const missingReadResources = useMemo(() => {
    const missing = new Set<string>();
    for (const scope of selected) {
      if (scope.endsWith(":read")) {
        continue;
      }
      const [resource] = scope.split(":") as [string];
      if (!selected.has(`${resource}:read` as Scope)) {
        missing.add(resource);
      }
    }
    return Array.from(missing);
  }, [selected]);

  const selectedList = useMemo(
    () => ALL_SCOPES.filter((s) => selected.has(s)),
    [selected]
  );

  // Functional setState so handler identities stay stable across renders.
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

  const applyPreset = useCallback((scopes: readonly Scope[]) => {
    setSelected(new Set(scopes));
  }, []);

  // Toggle a whole column: clear the group if it's already fully selected,
  // otherwise add every scope in it.
  const toggleColumn = useCallback((scopes: readonly Scope[]) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const allSelected = scopes.every((s) => next.has(s));
      for (const s of scopes) {
        if (allSelected) {
          next.delete(s);
        } else {
          next.add(s);
        }
      }
      return next;
    });
  }, []);

  // A failed roster fetch falls back to a self-mint rather than blocking;
  // only an in-flight load (no error yet) gates submit.
  const canSubmit =
    Boolean(name.trim()) &&
    selected.size > 0 &&
    Boolean(ownerId) &&
    (users !== null || usersError) &&
    !isPending;

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
          user_id: ownerId,
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
          Write actions (like claiming a run) are attributed to the selected
          user.
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
          <Label htmlFor="token-owner">User</Label>
          {usersError ? (
            <p className="text-muted-foreground text-sm">
              Couldn't load workspace members. This token will be created for
              you — reopen the dialog to choose a different owner.
            </p>
          ) : (
            <Select
              disabled={users === null}
              onValueChange={setOwnerId}
              value={ownerId}
            >
              <SelectTrigger id="token-owner">
                <SelectValue
                  placeholder={
                    users === null ? "Loading members…" : "Select user"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {(users ?? []).map((user) => (
                  <SelectItem key={user.id} value={user.id}>
                    {userLabel(user)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
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
          {expiry === "none" ? (
            <p className="flex items-center gap-1.5 text-amber-600 text-xs dark:text-amber-500">
              <TriangleAlert className="size-3.5 shrink-0" />
              This token never expires. Prefer a fixed expiry and rotate it.
            </p>
          ) : null}
        </div>
        <div className="grid gap-2">
          <Label>Scopes</Label>
          <PresetPicker activePresetId={activePresetId} onApply={applyPreset} />
          <Collapsible onOpenChange={setCustomOpen} open={customOpen}>
            <CollapsibleTrigger asChild>
              <Button
                className="w-full justify-between text-muted-foreground"
                size="sm"
                type="button"
                variant="ghost"
              >
                Customize scopes
                <ChevronsUpDown className="size-4" />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2">
              <ScopeGrid
                groups={groups}
                onToggle={toggle}
                onToggleColumn={toggleColumn}
                selected={selected}
              />
            </CollapsibleContent>
          </Collapsible>
          <CapabilitySummary scopes={selectedList} />
          {activePresetId === null && missingReadResources.length > 0 ? (
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertDescription>
                No read access for {missingReadResources.join(", ")}. Add the
                matching read scope if the tool needs to fetch these resources.
              </AlertDescription>
            </Alert>
          ) : null}
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

function PresetPicker({
  activePresetId,
  onApply,
}: {
  activePresetId: string | null;
  onApply: (scopes: readonly Scope[]) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {SCOPE_PRESETS.map((preset) => (
        <Tooltip key={preset.id}>
          <TooltipTrigger asChild>
            <Button
              onClick={() => onApply(preset.scopes)}
              size="sm"
              type="button"
              variant={activePresetId === preset.id ? "default" : "outline"}
            >
              {preset.label}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{preset.description}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

function ScopeGrid({
  groups,
  selected,
  onToggle,
  onToggleColumn,
}: {
  groups: ResourceGroup[];
  selected: Set<Scope>;
  onToggle: (s: Scope) => void;
  onToggleColumn: (scopes: readonly Scope[]) => void;
}) {
  return (
    <TooltipProvider>
      <div className="rounded-md border bg-background dark:bg-muted">
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
          <span className="font-medium text-muted-foreground text-xs">
            Resource
          </span>
          <div className="flex gap-1">
            <Button
              onClick={() => onToggleColumn(READ_SCOPES)}
              size="sm"
              type="button"
              variant="ghost"
            >
              All read
            </Button>
            <Button
              onClick={() => onToggleColumn(WRITE_SCOPES)}
              size="sm"
              type="button"
              variant="ghost"
            >
              All write
            </Button>
          </div>
        </div>
        <div className="max-h-64 overflow-y-auto px-3 py-2">
          {groups.map((group) => (
            <div className="py-1.5" key={group.resource}>
              <div className="font-medium text-xs capitalize">
                {group.resource.replace("-", " ")}
              </div>
              <div className="mt-1 grid gap-1.5">
                {group.scopes.map((scope) => (
                  <ScopeRow
                    key={scope}
                    onToggle={onToggle}
                    scope={scope}
                    selected={selected.has(scope)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </TooltipProvider>
  );
}

function ScopeRow({
  scope,
  selected,
  onToggle,
}: {
  scope: Scope;
  selected: boolean;
  onToggle: (s: Scope) => void;
}) {
  const meta = SCOPE_METADATA[scope];
  return (
    <label
      className="flex cursor-pointer items-center gap-2 text-sm"
      htmlFor={`scope-${scope}`}
    >
      <Checkbox
        checked={selected}
        id={`scope-${scope}`}
        onCheckedChange={() => onToggle(scope)}
      />
      <span className="flex flex-1 items-center justify-between gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex items-center gap-1.5">
              {meta.label}
              {meta.destructive ? (
                <TriangleAlert className="size-3 text-amber-600 dark:text-amber-500" />
              ) : null}
            </span>
          </TooltipTrigger>
          <TooltipContent side="right">{meta.description}</TooltipContent>
        </Tooltip>
        <code className="text-muted-foreground text-xs">{scope}</code>
      </span>
    </label>
  );
}

function CapabilitySummary({ scopes }: { scopes: Scope[] }) {
  if (scopes.length === 0) {
    return (
      <p className="text-muted-foreground text-xs italic">
        No scopes selected yet.
      </p>
    );
  }
  return (
    <div className="rounded-md border bg-muted/40 px-3 py-2">
      <p className="mb-1 font-medium text-xs">This token will be able to:</p>
      <ul className="grid gap-0.5">
        {scopes.map((scope) => {
          const meta = SCOPE_METADATA[scope];
          return (
            <li
              className={`flex items-center gap-1.5 text-xs ${meta.destructive ? "text-amber-600 dark:text-amber-500" : "text-muted-foreground"}`}
              key={scope}
            >
              {meta.destructive ? (
                <TriangleAlert className="size-3 shrink-0" />
              ) : (
                <span className="size-1 shrink-0 rounded-full bg-current opacity-60" />
              )}
              {meta.description}
            </li>
          );
        })}
      </ul>
    </div>
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
