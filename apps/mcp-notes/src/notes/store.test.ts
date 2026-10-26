import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NotesStore, openDatabase } from "./store.js";

const AT = "2026-10-12T09:00:00.000Z";
const fresh = () => new NotesStore(openDatabase(":memory:"));

describe("NotesStore", () => {
  it("creates notes with increasing ids and reads them back whole", () => {
    const store = fresh();
    const a = store.create("First", "body one", AT);
    const b = store.create("Second", "body two", AT);
    expect(b.id).toBeGreaterThan(a.id);
    expect(store.get(a.id)).toEqual({ id: a.id, title: "First", body: "body one", created_at: AT });
    expect(store.get(9999)).toBeUndefined();
  });

  it("lists newest first, cuts the preview, and pages with offset", () => {
    const store = fresh();
    for (let i = 1; i <= 5; i++) store.create(`Note ${i}`, "x".repeat(300), AT);
    const page1 = store.list(2, 0);
    expect(page1.map((n) => n.title)).toEqual(["Note 5", "Note 4"]);
    expect(page1[0]?.preview).toHaveLength(100);
    expect(store.list(2, 2).map((n) => n.title)).toEqual(["Note 3", "Note 2"]);
    expect(store.list(10, 4).map((n) => n.title)).toEqual(["Note 1"]);
  });

  it("searches title and body, case-insensitively, newest first", () => {
    const store = fresh();
    store.create("Groceries", "milk and eggs", AT);
    store.create("Meeting", "Plan Q4 with ALICE", AT);
    store.create("alice's birthday", "buy a cake", AT);
    expect(store.search("alice", 10).map((n) => n.title)).toEqual(["alice's birthday", "Meeting"]);
    expect(store.search("EGGS", 10).map((n) => n.title)).toEqual(["Groceries"]);
    expect(store.search("nothing matches this", 10)).toEqual([]);
    expect(store.search("alice", 1)).toHaveLength(1);
  });

  it("treats % and _ in a search as plain characters, not wildcards", () => {
    const store = fresh();
    store.create("Discount", "save 100% today", AT);
    store.create("Snake", "some_variable_name", AT);
    store.create("Other", "nothing special", AT);
    expect(store.search("100%", 10).map((n) => n.title)).toEqual(["Discount"]);
    expect(store.search("_", 10).map((n) => n.title)).toEqual(["Snake"]);
  });

  it("stores hostile text as text (parameters, not string concatenation)", () => {
    const store = fresh();
    store.create("'; DROP TABLE notes; --", "\"; DELETE FROM notes; --", AT);
    expect(store.count()).toBe(1);
    expect(store.search("drop table", 10)).toHaveLength(1);
  });

  it("counts, and ping succeeds on a healthy database", () => {
    const store = fresh();
    expect(store.count()).toBe(0);
    store.create("a", "b", AT);
    expect(store.count()).toBe(1);
    expect(() => store.ping()).not.toThrow();
  });

  it("keeps notes across a restart: a file database survives closing and reopening", () => {
    const dir = mkdtempSync(join(tmpdir(), "notes-test-"));
    try {
      const path = join(dir, "notes.db");
      const first = openDatabase(path);
      const id = new NotesStore(first).create("Remember me", "still here after restart", AT).id;
      first.close();

      const second = openDatabase(path); // what the next pod does with the same volume
      expect(new NotesStore(second).get(id)?.body).toBe("still here after restart");
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ping throws once the database is closed (so /readyz can report it)", () => {
    const db = openDatabase(":memory:");
    const store = new NotesStore(db);
    db.close();
    expect(() => store.ping()).toThrow();
  });
});
