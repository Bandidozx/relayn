/**
 * Password hashing with scrypt from node:crypto.
 *
 * Chosen over bcrypt/argon2 bindings because it is memory-hard, in the standard
 * library (no native build step, no supply-chain surface) and comparison is done in
 * constant time. Stored format:
 *
 *   scrypt$N$r$p$<salt-b64url>$<hash-b64url>
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, PARAMS);
  return [
    "scrypt",
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

/**
 * `stored` is nullable because an account created through an identity provider has no
 * password at all. NULL is treated as "never matches" rather than as an empty password, so
 * a passwordless account cannot be signed into, deleted or re-credentialled by submitting a
 * blank field.
 */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const N = Number.parseInt(parts[1] ?? "", 10);
  const r = Number.parseInt(parts[2] ?? "", 10);
  const p = Number.parseInt(parts[3] ?? "", 10);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  const salt = Buffer.from(parts[4] ?? "", "base64url");
  const expected = Buffer.from(parts[5] ?? "", "base64url");
  if (salt.length === 0 || expected.length === 0) return false;

  const derived = await scrypt(password.normalize("NFKC"), salt, expected.length, {
    N,
    r,
    p,
    maxmem: PARAMS.maxmem,
  });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * Minimum policy enforced server-side (the client mirrors it for UX only).
 * Returns a human-readable reason, or null when acceptable.
 */
export function passwordPolicyError(password: string): string | null {
  if (password.length < 10) return "Password must be at least 10 characters.";
  if (password.length > 200) return "Password must be 200 characters or fewer.";
  if (!/[a-zA-Z]/.test(password)) return "Password must contain at least one letter.";
  if (!/[0-9]/.test(password)) return "Password must contain at least one number.";
  return null;
}
