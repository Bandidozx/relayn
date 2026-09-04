/**
 * Credential sealing for dashboard-added providers.
 *
 * This is the one place in Relayn where a secret has to be recoverable — the gateway must
 * present the upstream's plaintext key on every request — so the properties asserted here are
 * the ones that keep that from becoming a liability: a tampered row must fail closed rather
 * than decrypt to attacker-chosen bytes, a rotated key must produce an actionable error instead
 * of silence, and nothing but the last four characters may ever be displayable again.
 *
 * `env` snapshots `process.env` at import time, so every case stubs the environment first and
 * re-imports the module graph (the pattern used by tests/oauth-google.test.ts).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const KEY_A = "a1".repeat(32);
const KEY_B = "b2".repeat(32);

type SecretBox = typeof import("@/lib/security/secret-box");

/** Fresh module graph with a chosen key, so seal/open pairs are deterministic. */
async function box(overrides: Record<string, string> = {}): Promise<SecretBox> {
  vi.stubEnv("SESSION_SECRET", "s".repeat(48));
  vi.stubEnv("PROVIDER_CREDENTIAL_KEY", KEY_A);
  for (const [name, value] of Object.entries(overrides)) vi.stubEnv(name, value);
  vi.resetModules();
  const loaded = await import("@/lib/security/secret-box");
  loaded.resetSecretBoxKey();
  return loaded;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sealSecret / openSecret", () => {
  it("round-trips a credential", async () => {
    const { sealSecret, openSecret } = await box();
    // Shape-realistic but synthetic. A real upstream key used as a fixture would sit in git
    // history forever, and nothing here depends on the value being genuine.
    const secret = "sk-mdfk-Sy1nTh3t1cFixtureValueNotARealCredential4Test";
    expect(openSecret(sealSecret(secret))).toBe(secret);
  });

  it("emits the versioned four-part envelope and never the plaintext", async () => {
    const { sealSecret } = await box();
    const sealed = sealSecret("jr_cup_synthetic0fixture0value0notreal");
    const parts = sealed.split(".");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("v1");
    expect(sealed).not.toContain("jr_cup");
  });

  it("uses a fresh IV per seal, so two seals of one value differ", async () => {
    const { sealSecret, openSecret } = await box();
    const first = sealSecret("same-key");
    const second = sealSecret("same-key");
    expect(first).not.toBe(second);
    expect(openSecret(first)).toBe(openSecret(second));
  });

  it("round-trips multi-byte characters", async () => {
    const { sealSecret, openSecret } = await box();
    const secret = "kunci-räħäsıa-🔐";
    expect(openSecret(sealSecret(secret))).toBe(secret);
  });

  it("refuses to seal an empty secret", async () => {
    const { sealSecret, SecretBoxError } = await box();
    expect(() => sealSecret("")).toThrow(SecretBoxError);
  });
});

describe("openSecret — failure modes", () => {
  it("rejects a tampered ciphertext instead of returning garbage", async () => {
    const { sealSecret, openSecret, SecretBoxError } = await box();
    const parts = sealSecret("sk-original-value").split(".");
    const flipped = Buffer.from(parts[3]!, "base64url");
    flipped[0] = flipped[0]! ^ 0x01;
    const tampered = [parts[0], parts[1], parts[2], flipped.toString("base64url")].join(".");
    expect(() => openSecret(tampered)).toThrow(SecretBoxError);
  });

  it("rejects a swapped authentication tag", async () => {
    const { sealSecret, openSecret, SecretBoxError } = await box();
    const mine = sealSecret("sk-one").split(".");
    const theirs = sealSecret("sk-two").split(".");
    const spliced = [mine[0], mine[1], theirs[2], mine[3]].join(".");
    expect(() => openSecret(spliced)).toThrow(SecretBoxError);
  });

  it("rejects a value sealed with a different key, with an actionable message", async () => {
    const sealer = await box();
    const sealed = sealer.sealSecret("sk-rotated-away");

    // A deployment that rotated PROVIDER_CREDENTIAL_KEY: same row, different key material.
    const opener = await box({ PROVIDER_CREDENTIAL_KEY: KEY_B });
    expect(() => opener.openSecret(sealed)).toThrow(/re-enter it/);
  });

  it("rejects malformed envelopes rather than guessing", async () => {
    const { openSecret, SecretBoxError } = await box();
    for (const bad of ["", "not-sealed", "v1.only.three", "v2.aa.bb.cc", "v1.a.b.c.d"]) {
      expect(() => openSecret(bad)).toThrow(SecretBoxError);
    }
  });

  it("rejects an IV or tag of the wrong length", async () => {
    const { sealSecret, openSecret } = await box();
    const parts = sealSecret("sk-length-check").split(".");
    const shortIv = [parts[0], Buffer.alloc(8).toString("base64url"), parts[2], parts[3]].join(".");
    const shortTag = [parts[0], parts[1], Buffer.alloc(4).toString("base64url"), parts[3]].join(".");
    expect(() => openSecret(shortIv)).toThrow(/malformed IV or authentication tag/);
    expect(() => openSecret(shortTag)).toThrow(/malformed IV or authentication tag/);
  });

  it("refuses a PROVIDER_CREDENTIAL_KEY that is not 32 hex-encoded bytes", async () => {
    const { sealSecret } = await box({ PROVIDER_CREDENTIAL_KEY: "too-short" });
    expect(() => sealSecret("sk-anything")).toThrow(/64 hexadecimal characters/);
  });
});

describe("key derivation", () => {
  it("falls back to a key derived from SESSION_SECRET when no dedicated key is set", async () => {
    const { sealSecret, openSecret } = await box({ PROVIDER_CREDENTIAL_KEY: "" });
    expect(openSecret(sealSecret("sk-derived-path"))).toBe("sk-derived-path");
  });

  it("makes credentials unopenable when SESSION_SECRET rotates without a dedicated key", async () => {
    // Documented consequence of the derived path — asserted so it stays a loud failure.
    const sealer = await box({ PROVIDER_CREDENTIAL_KEY: "" });
    const sealed = sealer.sealSecret("sk-tied-to-session");
    const opener = await box({ PROVIDER_CREDENTIAL_KEY: "", SESSION_SECRET: "t".repeat(48) });
    expect(() => opener.openSecret(sealed)).toThrow(/re-enter it/);
  });

  it("derives a credential key unrelated to the session secret itself", async () => {
    const { sealSecret } = await box({ PROVIDER_CREDENTIAL_KEY: "" });
    // HKDF output is not the secret: the sealed blob must not embed the session secret.
    expect(sealSecret("sk-domain-separated")).not.toContain("s".repeat(16));
  });
});

describe("canOpenSecret", () => {
  it("answers without throwing, for status displays", async () => {
    const { sealSecret, canOpenSecret } = await box();
    expect(canOpenSecret(sealSecret("sk-fine"))).toBe(true);
    expect(canOpenSecret("v1.aa.bb.cc")).toBe(false);
    expect(canOpenSecret(null)).toBe(false);
    expect(canOpenSecret(undefined)).toBe(false);
    expect(canOpenSecret("")).toBe(false);
  });
});

describe("secretHint", () => {
  it("shows only the last four characters", async () => {
    const { secretHint } = await box();
    expect(secretHint("sk-mdfk-Sy1nTh3t1cFixtureValueNotARealCredential4Test")).toBe("••••Test");
  });

  it("masks a short secret entirely rather than revealing half of it", async () => {
    const { secretHint } = await box();
    expect(secretHint("12345678")).toBe("••••");
    expect(secretHint("abc")).toBe("••••");
    expect(secretHint("")).toBe("••••");
  });

  it("never returns more than four characters of the original", async () => {
    const { secretHint } = await box();
    const secret = "sk-supersecret-value-1234567890";
    const hint = secretHint(secret);
    expect(hint.replace(/•/g, "")).toBe("7890");
    expect(secret).toContain(hint.replace(/•/g, ""));
  });
});

describe("secretsEqual", () => {
  it("compares equal-length values", async () => {
    const { secretsEqual } = await box();
    expect(secretsEqual("sk-abc", "sk-abc")).toBe(true);
    expect(secretsEqual("sk-abc", "sk-abd")).toBe(false);
  });

  it("returns false on a length mismatch instead of throwing", async () => {
    const { secretsEqual } = await box();
    expect(secretsEqual("short", "much-longer-value")).toBe(false);
  });
});
