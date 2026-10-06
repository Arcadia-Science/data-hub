// AES-256-GCM for secrets admins save in the database (Slack and Linear
// credentials). The key lives only in `INTEGRATION_SECRETS_KEY`. Stored
// values look like `v1:<iv>:<tag>:<ciphertext>`, all base64url. Anything
// that does not start with that prefix is a legacy plaintext value.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PREFIX = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ALGORITHM = "aes-256-gcm";

export class IntegrationSecretsKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationSecretsKeyError";
  }
}

export function isEncryptedIntegrationSecret(value: string): boolean {
  return value.startsWith(`${PREFIX}:`);
}

function integrationSecretsKey(): Buffer {
  const raw = process.env.INTEGRATION_SECRETS_KEY?.trim();
  if (!raw) {
    throw new IntegrationSecretsKeyError(
      "INTEGRATION_SECRETS_KEY must be set before integration secrets can be saved."
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new IntegrationSecretsKeyError(
      "INTEGRATION_SECRETS_KEY must be 64 hex characters (32 bytes). Generate one with `openssl rand -hex 32`."
    );
  }
  return Buffer.from(raw, "hex");
}

export function encryptIntegrationSecret(plaintext: string): string {
  const key = integrationSecretsKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    PREFIX,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

export function decryptIntegrationSecret(stored: string): string {
  const parts = stored.split(":");
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new Error("Integration secret is not in the encrypted format.");
  }
  const iv = Buffer.from(parts[1], "base64url");
  const tag = Buffer.from(parts[2], "base64url");
  const ciphertext = Buffer.from(parts[3], "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error("Integration secret is not in the encrypted format.");
  }

  const decipher = createDecipheriv(ALGORITHM, integrationSecretsKey(), iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

// Plaintext values pass through so rows saved before encryption still work.
// Encrypted values the current key cannot open are treated as unset: a
// missing or rotated key must not leak ciphertext into a webhook call.
export function readMaybeEncryptedSecret(stored: string | null): string | null {
  if (stored == null || stored.length === 0) {
    return null;
  }
  if (!isEncryptedIntegrationSecret(stored)) {
    return stored;
  }
  try {
    return decryptIntegrationSecret(stored);
  } catch (err) {
    if (err instanceof IntegrationSecretsKeyError) {
      console.error(err.message);
    }
    return null;
  }
}
