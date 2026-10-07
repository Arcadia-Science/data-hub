"use client";

import { useState } from "react";
import { useLinearSetup } from "./linear-setup-context";

// The step and the summary both save a signing secret the same way, so they
// share this state and one save routine.
export function useSigningSecretForm(onSaved?: () => void) {
  const { actions } = useLinearSetup();
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSave = secret.trim() !== "" && !saving;

  async function save() {
    if (!canSave) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await actions.saveSigningSecret(secret.trim());
      setSecret("");
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setSaving(false);
    }
  }

  return { canSave, error, save, saving, secret, setSecret };
}
