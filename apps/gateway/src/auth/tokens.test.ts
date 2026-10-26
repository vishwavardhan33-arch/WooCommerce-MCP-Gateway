import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { API_KEY_TAG, generateApiKey, hashApiKey, hmacSha256Hex, randomToken, sha256Hex } from "./tokens.js";

describe("API key hashing", () => {
  it("generates a tagged key, a display prefix, and the sha256 of the key", () => {
    const { key, keyPrefix, keyHash } = generateApiKey();
    expect(key.startsWith(API_KEY_TAG)).toBe(true);
    expect(keyPrefix).toBe(key.slice(0, 12));
    // Compared with Node's own sha256 so the test does not just repeat our implementation.
    expect(keyHash).toBe(createHash("sha256").update(key).digest("hex"));
    expect(keyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never leaks the key through its prefix or hash", () => {
    const { key, keyPrefix, keyHash } = generateApiKey();
    expect(keyHash).not.toContain(key);
    expect(keyPrefix.length).toBeLessThan(key.length / 2);
  });

  it("hashing is deterministic, and different keys give different hashes", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(hashApiKey(a.key)).toBe(a.keyHash);
    expect(a.key).not.toBe(b.key);
    expect(a.keyHash).not.toBe(b.keyHash);
  });
});

describe("token helpers", () => {
  it("randomToken is URL-safe, 256 bits, and not repeated", () => {
    const t = randomToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes in base64url
    expect(randomToken()).not.toBe(t);
  });

  it("hmac depends on the secret, plain sha256 does not", () => {
    expect(hmacSha256Hex("secret-one", "token")).not.toBe(hmacSha256Hex("secret-two", "token"));
    expect(hmacSha256Hex("secret-one", "token")).not.toBe(sha256Hex("token"));
  });
});
