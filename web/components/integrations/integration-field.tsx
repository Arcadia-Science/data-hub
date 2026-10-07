import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type {
  FieldSource,
  PlainFieldStatus,
  SecretFieldStatus,
} from "@/lib/integrations/field-status";

function sourceText(source: FieldSource | null, envName?: string): string {
  if (source === "database") {
    return "Saved here";
  }
  if (source === "environment") {
    return envName ? `Using ${envName}` : "Using an environment variable";
  }
  if (source === "unreadable") {
    return "Can't read saved value";
  }
  return "Not set";
}

function unreadableMessage(set: boolean, envName?: string): string {
  const fallback = set && envName ? ` ${envName} is being used instead.` : "";
  return `Data Hub can't read the saved value.${fallback} Check INTEGRATION_SECRETS_KEY, or paste the value again and save.`;
}

/**
 * One integration setting: a label, where the current value comes from, an
 * input, and, when `onClear` is given, a button that removes the saved value.
 * `type="password"` is for secrets, which are never sent back to the browser,
 * so the input starts empty and a new value replaces the saved one.
 */
export function IntegrationField({
  clearing = false,
  description,
  envName,
  id,
  label,
  onChange,
  onClear,
  placeholder,
  status,
  type,
  value,
}: {
  clearing?: boolean;
  description: string;
  envName?: string;
  id: string;
  label: string;
  onChange: (value: string) => void;
  onClear?: () => void;
  placeholder?: string;
  status: PlainFieldStatus | SecretFieldStatus;
  type: "password" | "text";
  value: string;
}) {
  const canClear =
    onClear != null &&
    (status.source === "database" || status.source === "unreadable");

  return (
    <Field>
      <div className="flex items-center justify-between gap-2">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Badge
          variant={status.source === "unreadable" ? "destructive" : "secondary"}
        >
          {sourceText(status.source, envName)}
        </Badge>
      </div>
      <Input
        autoComplete="off"
        className="font-mono"
        id={id}
        onChange={(event) => onChange(event.target.value)}
        placeholder={
          type === "password" && status.set
            ? "Paste a new value to replace it"
            : placeholder
        }
        spellCheck={false}
        type={type}
        value={value}
      />
      <FieldDescription>{description}</FieldDescription>
      {status.source === "unreadable" ? (
        <FieldError>{unreadableMessage(status.set, envName)}</FieldError>
      ) : null}
      {canClear ? (
        <Button
          disabled={clearing}
          onClick={onClear}
          size="sm"
          type="button"
          variant="outline"
        >
          {clearing ? (
            <Loader2 className="animate-spin" data-icon="inline-start" />
          ) : null}
          Remove saved value
        </Button>
      ) : null}
    </Field>
  );
}
