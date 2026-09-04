/**
 * Password storage. The spec is blunt about this: never store plaintext. These tests pin
 * the stored *format* as well as the verify behaviour, because a silently-changed format
 * would lock every existing account out on deploy.
 */
import { describe, expect, it } from "vitest";
import { hashPassword, passwordPolicyError, verifyPassword } from "@/lib/security/password";

const PASSWORD = "Correct-Horse-9";

describe("hashPassword", () => {
  it("never returns the plaintext", async () => {
    const stored = await hashPassword(PASSWORD);
    expect(stored).not.toContain(PASSWORD);
  });

  it("emits the documented scrypt$N$r$p$salt$hash envelope", async () => {
    const parts = (await hashPassword(PASSWORD)).split("$");
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe("scrypt");
    expect(Number(parts[1])).toBe(16384);
    expect(Number(parts[2])).toBe(8);
    expect(Number(parts[3])).toBe(1);
    expect(parts[4]).toMatch(/^[A-Za-z0-9_-]{22}$/); // 16-byte salt
    expect(parts[5]).toMatch(/^[A-Za-z0-9_-]{86}$/); // 64-byte key
  });

  it("salts, so the same password hashes differently every time", async () => {
    const [a, b] = await Promise.all([hashPassword(PASSWORD), hashPassword(PASSWORD)]);
    expect(a).not.toBe(b);
    await expect(verifyPassword(PASSWORD, a)).resolves.toBe(true);
    await expect(verifyPassword(PASSWORD, b)).resolves.toBe(true);
  });
});

describe("verifyPassword", () => {
  it("accepts the right password and rejects a near miss", async () => {
    const stored = await hashPassword(PASSWORD);
    await expect(verifyPassword(PASSWORD, stored)).resolves.toBe(true);
    await expect(verifyPassword("correct-Horse-9", stored)).resolves.toBe(false);
    await expect(verifyPassword(`${PASSWORD} `, stored)).resolves.toBe(false);
    await expect(verifyPassword("", stored)).resolves.toBe(false);
  });

  it("normalises Unicode so an equivalent composition still logs in", async () => {
    // "é" as one code point vs "e" + combining acute.
    const stored = await hashPassword("passé-word-1");
    await expect(verifyPassword("passé-word-1", stored)).resolves.toBe(true);
  });

  it("returns false rather than throwing on a malformed record", async () => {
    for (const bad of [
      "",
      "not-a-hash",
      "scrypt$16384$8$1$onlyfiveparts",
      "bcrypt$16384$8$1$c2FsdA$aGFzaA",
      "scrypt$x$y$z$c2FsdA$aGFzaA",
      "scrypt$16384$8$1$$aGFzaA",
      "scrypt$16384$8$1$c2FsdA$",
    ]) {
      await expect(verifyPassword(PASSWORD, bad)).resolves.toBe(false);
    }
  });

  it("rejects a tampered digest", async () => {
    const stored = await hashPassword(PASSWORD);
    const parts = stored.split("$");
    const digest = parts[5] as string;
    const flipped = (digest[0] === "A" ? "B" : "A") + digest.slice(1);
    parts[5] = flipped;
    await expect(verifyPassword(PASSWORD, parts.join("$"))).resolves.toBe(false);
  });
});

describe("passwordPolicyError", () => {
  it("accepts a password meeting every rule", () => {
    expect(passwordPolicyError(PASSWORD)).toBeNull();
  });

  it("names the specific rule that failed", () => {
    expect(passwordPolicyError("short-1")).toMatch(/at least 10/);
    expect(passwordPolicyError("1234567890")).toMatch(/one letter/);
    expect(passwordPolicyError("abcdefghijkl")).toMatch(/one number/);
    expect(passwordPolicyError(`${"a1".repeat(101)}`)).toMatch(/200 characters or fewer/);
  });
});
