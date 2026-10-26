import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";

describe("passwords", () => {
  it("hashes with argon2id and verifies only the right password", async () => {
    const hash = await hashPassword("correct-horse-battery");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(hash).not.toContain("correct-horse-battery");
    expect(await verifyPassword(hash, "correct-horse-battery")).toBe(true);
    expect(await verifyPassword(hash, "wrong-password-here")).toBe(false);
  });

  it("salts: the same password gives a different hash each time", async () => {
    expect(await hashPassword("same-password-twice")).not.toBe(await hashPassword("same-password-twice"));
  });

  it("treats a malformed stored hash as 'no match' instead of throwing", async () => {
    expect(await verifyPassword("not-a-hash", "anything-at-all")).toBe(false);
  });
});
