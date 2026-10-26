import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptCredential, encryptCredential } from "./crypto.js";

const key = randomBytes(32);

describe("credential encryption (AES-256-GCM)", () => {
  it("round-trips and never stores the plaintext", () => {
    const enc = encryptCredential(key, "s3cret-bearer-token");
    expect(enc).not.toContain("s3cret");
    expect(Buffer.from(enc, "base64").toString("utf8")).not.toContain("s3cret");
    expect(decryptCredential(key, enc)).toBe("s3cret-bearer-token");
  });

  it("uses a new IV each time: the same input encrypts differently", () => {
    expect(encryptCredential(key, "same")).not.toBe(encryptCredential(key, "same"));
  });

  it("fails with the wrong key", () => {
    expect(() => decryptCredential(randomBytes(32), encryptCredential(key, "x"))).toThrow();
  });

  it("detects tampering with the ciphertext", () => {
    const raw = Buffer.from(encryptCredential(key, "some-credential"), "base64");
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 1; // flip one bit in the last byte
    expect(() => decryptCredential(key, raw.toString("base64"))).toThrow();
  });

  it("rejects input that is too short", () => {
    expect(() => decryptCredential(key, "AAAA")).toThrow(/too short/);
  });
});
