import { describe, expect, it } from "vitest";
import { describeWithSlug, MAX_TOOL_NAME_LENGTH, namespacedName, SLUG_PATTERN, slugOf } from "./namespacing.js";

const VALID = /^[A-Za-z0-9_-]{1,64}$/;

describe("namespacedName", () => {
  it("is always <slug>__<tool> when the result is already valid", () => {
    expect(namespacedName("shop", "list_products")).toBe("shop__list_products");
  });

  it("keeps different servers' same-named tools apart", () => {
    expect(namespacedName("alpha", "search")).not.toBe(namespacedName("beta", "search"));
  });

  it("truncates long names to 64 characters, keeping them valid", () => {
    const name = namespacedName("shop", "t".repeat(200));
    expect(name.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH);
    expect(name).toMatch(VALID);
    expect(name.startsWith("shop__tttt")).toBe(true);
  });

  it("two long names that only differ at the end do not collide", () => {
    const a = namespacedName("shop", `${"x".repeat(80)}_one`);
    const b = namespacedName("shop", `${"x".repeat(80)}_two`);
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(64);
    expect(b.length).toBeLessThanOrEqual(64);
  });

  it("replaces forbidden characters and still keeps 'a.b' and 'a_b' apart", () => {
    const dotted = namespacedName("shop", "a.b");
    const underscored = namespacedName("shop", "a_b");
    expect(dotted).toMatch(VALID);
    expect(dotted).not.toBe(underscored);
    expect(underscored).toBe("shop__a_b");
  });

  it("is stable: the same input always gives the same name", () => {
    expect(namespacedName("shop", "a.b")).toBe(namespacedName("shop", "a.b"));
  });

  it("handles unicode and spaces", () => {
    expect(namespacedName("shop", "récupérer les commandes")).toMatch(VALID);
  });
});

describe("routing helpers", () => {
  it("slugOf takes everything before the first double underscore", () => {
    expect(slugOf("shop__list_products")).toBe("shop");
    expect(slugOf("shop__a__b")).toBe("shop");
    expect(slugOf("noseparator")).toBeUndefined();
    expect(slugOf("__leading")).toBeUndefined();
  });

  it("slugs cannot contain '__' or be too long", () => {
    expect(SLUG_PATTERN.test("woo-shop")).toBe(true);
    expect(SLUG_PATTERN.test("a__b")).toBe(false);
    expect(SLUG_PATTERN.test("Shop")).toBe(false);
    expect(SLUG_PATTERN.test("1shop")).toBe(false); // must start with a letter
    expect(SLUG_PATTERN.test("-shop")).toBe(false);
    expect(SLUG_PATTERN.test("a".repeat(33))).toBe(false);
  });

  it("prefixes descriptions with [slug]", () => {
    expect(describeWithSlug("shop", "Lists products")).toBe("[shop] Lists products");
    expect(describeWithSlug("shop", undefined)).toBe("[shop]");
  });
});
