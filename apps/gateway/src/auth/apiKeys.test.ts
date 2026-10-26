import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { apiKeys } from "../db/schema.js";
import { HttpError } from "../http.js";
import { createTestDb, seedUser } from "../test/helpers.js";
import { authenticateApiKey, createApiKey, listApiKeys, revokeApiKey } from "./apiKeys.js";
import type { AuthUser } from "./types.js";

let db: Db;
let close: () => Promise<void>;
let alice: AuthUser; // member, owns the keys
let bob: AuthUser; // another member
let root: AuthUser; // admin

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  alice = (await seedUser(db, "alice@example.com", "member")) as AuthUser;
  bob = (await seedUser(db, "bob@example.com", "member")) as AuthUser;
  root = (await seedUser(db, "root@example.com", "admin")) as AuthUser;
}, 30_000);

afterAll(async () => {
  await close();
});

describe("key storage", () => {
  it("stores only the hash and the prefix, never the key", async () => {
    const { apiKey, key } = await createApiKey(db, alice.id, "laptop");
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, apiKey.id));
    expect(row.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.keyPrefix).toBe(key.slice(0, 12));
    expect(JSON.stringify(row)).not.toContain(key);
  });

  it("the list shows prefixes and dates but neither the key nor its hash", async () => {
    const { key } = await createApiKey(db, alice.id, "for the list test");
    const list = await listApiKeys(db, alice.id);
    expect(list.length).toBeGreaterThan(0);
    expect(JSON.stringify(list)).not.toContain(key);
    expect(JSON.stringify(list)).not.toContain("keyHash");
  });
});

describe("authenticateApiKey", () => {
  it("accepts a valid key, identifies the owner, and records last use", async () => {
    const { apiKey, key } = await createApiKey(db, alice.id, "ci");
    expect((await listApiKeys(db, alice.id)).find((k) => k.id === apiKey.id)?.lastUsedAt).toBeNull();

    const result = await authenticateApiKey(db, key);
    expect(result).toEqual({ keyId: apiKey.id, userId: alice.id, role: "member" });
    expect((await listApiKeys(db, alice.id)).find((k) => k.id === apiKey.id)?.lastUsedAt).not.toBeNull();
  });

  it("rejects unknown, malformed and empty keys", async () => {
    expect(await authenticateApiKey(db, "mcp_" + "x".repeat(43))).toBeUndefined();
    expect(await authenticateApiKey(db, "no-tag-at-all")).toBeUndefined();
    expect(await authenticateApiKey(db, "")).toBeUndefined();
  });
});

describe("revocation", () => {
  it("a revoked key stops working immediately", async () => {
    const { apiKey, key } = await createApiKey(db, alice.id, "to revoke");
    expect(await authenticateApiKey(db, key)).toBeDefined();

    await revokeApiKey(db, alice, apiKey.id);

    expect(await authenticateApiKey(db, key)).toBeUndefined();
    const listed = (await listApiKeys(db, alice.id)).find((k) => k.id === apiKey.id);
    expect(listed?.revokedAt).not.toBeNull(); // the row is kept, marked revoked
  });

  it("revoking twice keeps the original revocation time", async () => {
    const { apiKey } = await createApiKey(db, alice.id, "twice");
    await revokeApiKey(db, alice, apiKey.id);
    const first = (await listApiKeys(db, alice.id)).find((k) => k.id === apiKey.id)?.revokedAt;
    await revokeApiKey(db, alice, apiKey.id);
    const second = (await listApiKeys(db, alice.id)).find((k) => k.id === apiKey.id)?.revokedAt;
    expect(second).toEqual(first);
  });

  it("another member cannot revoke it, and gets 'not found' rather than 'forbidden'", async () => {
    const { apiKey, key } = await createApiKey(db, alice.id, "not bobs");
    await expect(revokeApiKey(db, bob, apiKey.id)).rejects.toMatchObject({ status: 404 });
    await expect(revokeApiKey(db, bob, apiKey.id)).rejects.toBeInstanceOf(HttpError);
    expect(await authenticateApiKey(db, key)).toBeDefined(); // still works
  });

  it("an admin can revoke anyone's key", async () => {
    const { apiKey, key } = await createApiKey(db, alice.id, "leaked");
    await revokeApiKey(db, root, apiKey.id);
    expect(await authenticateApiKey(db, key)).toBeUndefined();
  });

  it("revoking a key that does not exist is a 404", async () => {
    await expect(revokeApiKey(db, root, "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({
      status: 404,
    });
  });
});
