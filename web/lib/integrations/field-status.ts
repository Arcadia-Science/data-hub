// How an integration setting resolves and what the admin API reports for it.
// Shared by the Slack and Linear settings so both cards show the same states.

import type { SavedValue } from "@/lib/crypto/integration-secrets";

// `unreadable` means a value is saved but cannot be decrypted, usually
// because `INTEGRATION_SECRETS_KEY` is missing or changed. `set` still says
// whether an environment variable supplies a value in its place.
export type FieldSource = "database" | "environment" | "unreadable";

export interface SecretFieldStatus {
  set: boolean;
  source: FieldSource | null;
}

export interface PlainFieldStatus extends SecretFieldStatus {
  value: string | null;
}

export interface ResolvedField {
  source: FieldSource | null;
  value: string | null;
}

export function savedPlainValue(stored: string | null): SavedValue {
  const trimmed = stored?.trim();
  return trimmed ? { state: "readable", value: trimmed } : { state: "empty" };
}

// A saved value wins over the environment variable. An unreadable saved value
// still falls back to the variable so the integration keeps working, but the
// source stays `unreadable` so the admin sees that something needs fixing.
export function resolveIntegrationField(
  saved: SavedValue,
  envValue?: string
): ResolvedField {
  const fromEnv = envValue?.trim() ? envValue.trim() : null;
  if (saved.state === "readable" && saved.value.trim()) {
    return { value: saved.value.trim(), source: "database" };
  }
  if (saved.state === "unreadable") {
    return { value: fromEnv, source: "unreadable" };
  }
  if (fromEnv) {
    return { value: fromEnv, source: "environment" };
  }
  return { value: null, source: null };
}

export function secretFieldStatus(resolved: ResolvedField): SecretFieldStatus {
  return { set: resolved.value != null, source: resolved.source };
}

export function plainFieldStatus(resolved: ResolvedField): PlainFieldStatus {
  return { ...secretFieldStatus(resolved), value: resolved.value };
}
