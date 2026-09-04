/**
 * Authenticated encryption for credentials that have to live in the database.
 *
 * Every other secret in Relayn is either hashed (passwords, API keys — we never need the
 * original back) or read from the environment (upstream provider keys shipped with the
 * deployment). Dashboard-added providers are the one case where neither works: the gateway
 * must present the *plaintext* key to the upstream on every request, and the operator adds
 * it at runtime without a redeploy, so it cannot come from `process.env`.
 *
 * So it is sealed instead: AES-256-GCM, random 96-bit IV per seal, authentication tag kept
 * alongside. GCM is chosen over raw CBC/CTR because it authenticates — a row tampered with
 * in the database fails to open rather than silently decrypting to attacker-chosen bytes
 * that then get sent to an upstream, or worse, to an attacker-chosen `baseUrl`.
 *
 * Key material, in order of preference:
 *   1. `PROVIDER_CREDENTIAL_KEY` — 32 bytes as 64 hex characters. Use this in production;
 *      it can be rotated independently of the session secret.
 *   2. HKDF-SHA256 over `SESSION_SECRET` with a fixed, purpose-specific info string, so a
 *      deployment that has not set a dedicated key still gets a key that is unrelated to
 *      the one signing sessions and OAuth transactions.
 *
 * The consequence of (2) is documented and deliberate: rotating `SESSION_SECRET` without a
 * dedicated `PROVIDER_CREDENTIAL_KEY` makes existing sealed credentials unopenable. Callers
 * surface that as "re-enter the key", never as a silent failure — see `openSecret`.
 */
import "server-only";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { env, sessionSecret } from "@/lib/env";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const VERSION = "v1";
/** Domain separation for the derived-key path: this key must never equal a session key. */
const HKDF_INFO = "relayn/provider-credential/v1";

/** Raised when a sealed value cannot be opened. Never carries the ciphertext. */
export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretBoxError";
  }
}

let cachedKey: Buffer | null = null;

/**
 * Resolves the 32-byte key once per process. Cached because HKDF on every gateway request
 * would be pure waste — the inputs cannot change without a restart.
 */
function encryptionKey(): Buffer {
  if (cachedKey) return cachedKey;

  const configured = env.providerCredentialKey.trim();
  if (configured.length > 0) {
    if (!/^[0-9a-fA-F]{64}$/.test(configured)) {
      throw new SecretBoxError(
        "PROVIDER_CREDENTIAL_KEY must be exactly 64 hexadecimal characters (32 bytes).",
      );
    }
    cachedKey = Buffer.from(configured, "hex");
    return cachedKey;
  }

  // No salt: `SESSION_SECRET` is already high-entropy and the info string provides the
  // domain separation HKDF needs here. A random salt would have to be stored somewhere,
  // which is the problem this path exists to avoid.
  const derived = hkdfSync("sha256", sessionSecret(), new Uint8Array(0), HKDF_INFO, KEY_BYTES);
  cachedKey = Buffer.from(derived);
  return cachedKey;
}

/** Test-only: forces the next call to re-read the environment. */
export function resetSecretBoxKey(): void {
  cachedKey = null;
}

/**
 * Seals a plaintext secret. Output shape is `v1.<iv>.<tag>.<ciphertext>`, all base64url —
 * self-describing so a future algorithm change can be told apart from this one instead of
 * being fed to the wrong cipher.
 */
export function sealSecret(plaintext: string): string {
  if (plaintext.length === 0) throw new SecretBoxError("Refusing to seal an empty secret.");

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/**
 * Opens a sealed secret, or throws `SecretBoxError`. Every failure mode — wrong key,
 * truncated row, tampered ciphertext — lands here rather than returning a partial value,
 * so a caller cannot accidentally send garbage upstream.
 */
export function openSecret(sealed: string): string {
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new SecretBoxError("Sealed value is not in the expected v1 format.");
  }

  const iv = Buffer.from(parts[1]!, "base64url");
  const tag = Buffer.from(parts[2]!, "base64url");
  const ciphertext = Buffer.from(parts[3]!, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new SecretBoxError("Sealed value has a malformed IV or authentication tag.");
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, encryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // `final()` throws on tag mismatch, which is also what a rotated key looks like.
    throw new SecretBoxError(
      "Stored credential could not be decrypted. It was sealed with a different key — re-enter it.",
    );
  }
}

/** True when `sealed` opens cleanly. For status displays that must not throw. */
export function canOpenSecret(sealed: string | null | undefined): boolean {
  if (!sealed) return false;
  try {
    openSecret(sealed);
    return true;
  } catch {
    return false;
  }
}

/**
 * The only part of a credential this application will show again: enough to tell two keys
 * apart in the UI, not enough to use. Short secrets are masked entirely rather than
 * revealing a meaningful fraction of themselves.
 */
export function secretHint(plaintext: string): string {
  if (plaintext.length <= 8) return "••••";
  return `••••${plaintext.slice(-4)}`;
}

/** Constant-time equality for two secrets of equal length; false on any length mismatch. */
export function secretsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
