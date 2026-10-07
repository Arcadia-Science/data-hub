import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decryptIntegrationSecret,
  encryptIntegrationSecret,
  IntegrationSecretsKeyError,
  inspectSavedSecret,
  readMaybeEncryptedSecret,
} from "@/lib/crypto/integration-secrets";

const KEY = "ab".repeat(32);

describe("integration secrets", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("round-trips a secret and uses a fresh ciphertext each time", () => {
    vi.stubEnv("INTEGRATION_SECRETS_KEY", KEY);
    const first = encryptIntegrationSecret(
      "https://hooks.slack.com/services/T/B/x"
    );
    const second = encryptIntegrationSecret(
      "https://hooks.slack.com/services/T/B/x"
    );

    expect(first.startsWith("v1:")).toBe(true);
    expect(first).not.toBe(second);
    expect(decryptIntegrationSecret(first)).toBe(
      "https://hooks.slack.com/services/T/B/x"
    );
    expect(first).not.toContain("hooks.slack.com");
  });

  it("rejects a tampered ciphertext", () => {
    vi.stubEnv("INTEGRATION_SECRETS_KEY", KEY);
    const stored = encryptIntegrationSecret("secret-value");
    const parts = stored.split(":");
    const ciphertext = Buffer.from(parts[3], "base64url");
    ciphertext[0] = (ciphertext[0] + 1) % 256;
    parts[3] = ciphertext.toString("base64url");

    expect(() => decryptIntegrationSecret(parts.join(":"))).toThrow();
  });

  it("rejects a ciphertext opened with a different key", () => {
    vi.stubEnv("INTEGRATION_SECRETS_KEY", KEY);
    const stored = encryptIntegrationSecret("secret-value");
    vi.stubEnv("INTEGRATION_SECRETS_KEY", "cd".repeat(32));

    expect(() => decryptIntegrationSecret(stored)).toThrow();
  });

  it("refuses to encrypt when the key is missing or the wrong shape", () => {
    vi.stubEnv("INTEGRATION_SECRETS_KEY", "");
    expect(() => encryptIntegrationSecret("secret-value")).toThrow(
      IntegrationSecretsKeyError
    );

    vi.stubEnv("INTEGRATION_SECRETS_KEY", "too-short");
    expect(() => encryptIntegrationSecret("secret-value")).toThrow(
      IntegrationSecretsKeyError
    );
  });

  it("reads a legacy plaintext value and treats an unreadable secret as unset", () => {
    expect(readMaybeEncryptedSecret(null)).toBeNull();
    expect(
      readMaybeEncryptedSecret("https://hooks.slack.com/services/T/B/x")
    ).toBe("https://hooks.slack.com/services/T/B/x");

    vi.stubEnv("INTEGRATION_SECRETS_KEY", KEY);
    const stored = encryptIntegrationSecret("secret-value");
    vi.stubEnv("INTEGRATION_SECRETS_KEY", "");
    expect(readMaybeEncryptedSecret(stored)).toBeNull();
  });

  it("tells an empty value apart from a saved value that cannot be opened", () => {
    expect(inspectSavedSecret(null)).toEqual({ state: "empty" });
    expect(inspectSavedSecret("")).toEqual({ state: "empty" });
    expect(inspectSavedSecret("legacy-plaintext")).toEqual({
      state: "readable",
      value: "legacy-plaintext",
    });

    vi.stubEnv("INTEGRATION_SECRETS_KEY", KEY);
    const stored = encryptIntegrationSecret("secret-value");
    expect(inspectSavedSecret(stored)).toEqual({
      state: "readable",
      value: "secret-value",
    });

    vi.stubEnv("INTEGRATION_SECRETS_KEY", "cd".repeat(32));
    expect(inspectSavedSecret(stored)).toEqual({ state: "unreadable" });
    vi.stubEnv("INTEGRATION_SECRETS_KEY", "");
    expect(inspectSavedSecret(stored)).toEqual({ state: "unreadable" });
  });
});
