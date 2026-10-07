// Patch rules shared by every integration settings form: `undefined` keeps
// the saved value, `null` clears it, and a string replaces it.

import { encryptIntegrationSecret } from "@/lib/crypto/integration-secrets";

export function nextPlain(
  current: string | null,
  patch: string | null | undefined
): string | null {
  if (patch === undefined) {
    return current;
  }
  return patch;
}

// Encrypts a replacement before it is written. Throws
// `IntegrationSecretsKeyError` when `INTEGRATION_SECRETS_KEY` is not usable.
export function nextSecret(
  current: string | null,
  patch: string | null | undefined
): string | null {
  if (patch === undefined) {
    return current;
  }
  if (patch === null) {
    return null;
  }
  return encryptIntegrationSecret(patch);
}
