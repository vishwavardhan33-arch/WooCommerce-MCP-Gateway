import { describe, expect, it } from "vitest";
import { toFunctionParameters } from "./schema.js";

// Keywords Gemini's OpenAI-compatible endpoint rejects (or may reject). None may survive.
const BANNED = ["$schema", "additionalProperties", "exclusiveMinimum", "exclusiveMaximum", "default", "format", "$ref", "definitions", "$defs", "anyOf", "oneOf", "allOf", "const", "pattern", "minLength", "maxLength", "title", "examples", "minItems", "maxItems", "minimum", "maximum"];
const keysDeep = (v: unknown): string[] => (v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [k, ...keysDeep(x)]) : []);
const clean = (schema: unknown) => toFunctionParameters(schema) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// What McpServer + zod really produce for a tool like list_notes.
const zodStyle = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    limit: { type: "integer", exclusiveMinimum: 0, maximum: 100, default: 20, description: "Maximum number of notes." },
    id: { type: "string", format: "uuid", minLength: 36, maxLength: 36 },
    query: { type: "string", minLength: 1, maxLength: 200, pattern: "^[a-z]+$" },
    date: { anyOf: [{ type: "string", format: "date" }, { type: "null" }], description: "Optional day." },
    tags: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 5 },
  },
  required: ["limit", "ghost"],
  additionalProperties: false,
};

describe("toFunctionParameters", () => {
  it("keeps the structure and drops every keyword the allowlist does not name", () => {
    const out = clean(zodStyle);
    expect(out.type).toBe("object");
    expect(Object.keys(out.properties)).toEqual(["limit", "id", "query", "date", "tags"]);
    expect(keysDeep(out).filter((k) => BANNED.includes(k) && k !== "default" && k !== "format")).toEqual([]);
    // "default"/"format" can legitimately appear as a PROPERTY name elsewhere, so check the values instead:
    expect(JSON.stringify(out)).not.toContain('"exclusiveMinimum"');
    expect(JSON.stringify(out)).not.toContain('"additionalProperties"');
    expect(JSON.stringify(out)).not.toContain('"$schema"');
  });

  it("moves dropped constraints into the description in plain words", () => {
    const { limit, id, tags } = clean(zodStyle).properties;
    expect(limit.type).toBe("integer");
    expect(limit.description).toContain("Maximum number of notes.");
    expect(limit.description).toContain("default: 20");
    expect(limit.description).toContain("range: 0 to 100");
    expect(id.description).toContain("format: uuid");
    expect(tags.description).toContain("items: 0 to 5");
    expect(tags.items).toEqual({ type: "string" });
  });

  it("turns a null union into nullable, and keeps only required names that are real properties", () => {
    const out = clean(zodStyle);
    expect(out.properties.date).toMatchObject({ type: "string", nullable: true });
    expect(out.required).toEqual(["limit"]); // "ghost" is not a property
  });

  it("returns undefined for a tool without arguments (Gemini rejects an empty properties object)", () => {
    expect(toFunctionParameters({ type: "object", properties: {}, additionalProperties: false, $schema: "x" })).toBeUndefined();
    expect(toFunctionParameters({ type: "object" })).toBeUndefined();
    expect(toFunctionParameters(undefined)).toBeUndefined();
    expect(toFunctionParameters("nonsense")).toBeUndefined();
  });

  it("inlines local $ref definitions and survives a self-referencing schema", () => {
    const withRef = {
      type: "object",
      properties: { address: { $ref: "#/definitions/Address", description: "Where to ship." } },
      definitions: { Address: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
    };
    expect(clean(withRef).properties.address).toEqual({ type: "object", properties: { city: { type: "string" } }, required: ["city"], description: "Where to ship." });

    const loop = { type: "object", properties: { next: { $ref: "#/definitions/Node" } }, definitions: { Node: { type: "object", properties: { next: { $ref: "#/definitions/Node" } } } } };
    expect(() => toFunctionParameters(loop)).not.toThrow();
    expect(JSON.stringify(toFunctionParameters(loop)).includes("$ref")).toBe(false);
  });

  it("handles type lists, constants and enums", () => {
    const out = clean({
      type: "object",
      properties: {
        a: { type: ["string", "null"] },
        status: { type: "string", enum: ["open", "closed"] },
        level: { type: "integer", enum: [1, 2, 3] },
        kind: { const: "order" },
      },
    });
    expect(out.properties.a).toEqual({ type: "string", nullable: true });
    expect(out.properties.status).toEqual({ type: "string", enum: ["open", "closed"] });
    expect(out.properties.level.enum).toBeUndefined(); // only string enums are accepted
    expect(out.properties.level.description).toContain("one of: 1, 2, 3");
    expect(out.properties.kind).toEqual({ type: "string", enum: ["order"] });
  });

  it("collapses a multi-type union to its first member and says so", () => {
    const out = clean({ type: "object", properties: { v: { anyOf: [{ type: "number" }, { type: "string" }] } } });
    expect(out.properties.v.type).toBe("number");
    expect(out.properties.v.description).toContain("only the first is shown");
  });

  it("gives properties without a type a usable one", () => {
    const out = clean({ type: "object", properties: { x: {}, y: { properties: { z: { type: "string" } } }, w: { items: { type: "string" } } } });
    expect(out.properties.x.type).toBe("string");
    expect(out.properties.y.type).toBe("object");
    expect(out.properties.w.type).toBe("array");
  });
});
