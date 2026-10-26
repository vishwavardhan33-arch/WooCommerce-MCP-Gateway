// MCP tools describe their inputs with JSON Schema; the model API wants them as "function
// parameters". OpenAI accepts almost any JSON Schema, but Gemini's OpenAI-compatible endpoint
// accepts only a SMALL subset and rejects the whole request ("Unknown name ...") when it sees
// anything else: "$schema", "additionalProperties", "exclusiveMinimum", "default", "$ref", "anyOf"
// with a null member, "format: uuid", and so on. Libraries like zod emit exactly those.
//
// So this is an ALLOWLIST, not a blocklist: only the keywords below are ever copied to the output,
// so a keyword nobody thought of cannot get through. What is dropped is not lost for the model: the
// useful parts (ranges, formats, defaults) are written into the description as plain words. The
// upstream server still validates every call itself, so a dropped constraint can only cost a retry.

type Json = Record<string, unknown>;

const MAX_DEPTH = 8; // also stops a self-referencing ($ref) schema from recursing forever
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

const KNOWN_TYPES = new Set(["string", "number", "integer", "boolean", "array", "object"]);

const isNullSchema = (s: unknown): boolean => isObject(s) && (s.type === "null" || (s.const === null && s.type === undefined));

// "#/definitions/Foo" or "#/$defs/Foo" -> the schema it points to (only references inside the same document).
function resolveRef(ref: string, root: unknown): Json | undefined {
  const match = /^#\/(definitions|\$defs)\/(.+)$/.exec(ref);
  if (!match || !isObject(root)) return undefined;
  const table = root[match[1] as string];
  const target = isObject(table) ? table[decodeURIComponent(match[2] as string)] : undefined;
  return isObject(target) ? target : undefined;
}

// Plain-words versions of the constraints we cannot pass on as keywords.
function hints(node: Json, folded: { enumValues?: unknown[] }): string[] {
  const out: string[] = [];
  if (typeof node.format === "string") out.push(`format: ${node.format}`);
  if (node.default !== undefined) out.push(`default: ${JSON.stringify(node.default)}`);
  const lo = node.minimum ?? node.exclusiveMinimum;
  const hi = node.maximum ?? node.exclusiveMaximum;
  if (typeof lo === "number" || typeof hi === "number") out.push(`range: ${lo ?? "..."} to ${hi ?? "..."}`);
  if (node.minLength !== undefined || node.maxLength !== undefined) out.push(`length: ${node.minLength ?? 0} to ${node.maxLength ?? "..."} characters`);
  if (node.minItems !== undefined || node.maxItems !== undefined) out.push(`items: ${node.minItems ?? 0} to ${node.maxItems ?? "..."}`);
  if (typeof node.pattern === "string") out.push(`pattern: ${node.pattern}`);
  if (folded.enumValues) out.push(`one of: ${folded.enumValues.map((v) => JSON.stringify(v)).join(", ")}`);
  return out;
}

function sanitize(input: unknown, root: unknown, depth: number): Json {
  if (!isObject(input) || depth > MAX_DEPTH) return { type: "string" }; // `true` / unknown shapes: an unconstrained value

  let node: Json = input;
  if (typeof node.$ref === "string") {
    const target = resolveRef(node.$ref, root);
    node = target ? { ...target, ...(node.description ? { description: node.description } : {}) } : { description: node.description };
  }

  // Unions. A null member becomes `nullable: true`; of several other members only the first survives,
  // which keeps the request valid at the cost of precision (the description says so).
  let nullable = false;
  const note: string[] = [];
  const variants = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : Array.isArray(node.allOf) ? node.allOf : undefined;
  if (variants) {
    const real = variants.filter((v) => !isNullSchema(v));
    nullable = real.length < variants.length;
    if (real.length > 1 && !Array.isArray(node.allOf)) note.push("accepts several shapes; only the first is shown");
    const first = isObject(real[0]) ? real[0] : {};
    node = { ...first, description: node.description ?? first.description };
  }

  // "type" may be a list such as ["string", "null"].
  let type = node.type;
  if (Array.isArray(type)) {
    nullable = nullable || type.includes("null");
    type = type.find((t) => t !== "null");
  }
  if (type === "null") {
    nullable = true;
    type = "string";
  }
  // A constant is a one-value enum.
  const enumRaw = Array.isArray(node.enum) ? node.enum : node.const !== undefined && node.const !== null ? [node.const] : undefined;

  if (typeof type !== "string" || !KNOWN_TYPES.has(type)) {
    type = isObject(node.properties) ? "object" : node.items !== undefined ? "array" : typeof enumRaw?.[0] === "number" ? "number" : "string";
  }

  const out: Json = { type };
  // Gemini only accepts string enums. For other types the allowed values go into the description.
  const folded: { enumValues?: unknown[] } = {};
  if (enumRaw && enumRaw.length > 0) {
    if (type === "string" && enumRaw.every((v) => typeof v === "string")) out.enum = enumRaw;
    else folded.enumValues = enumRaw;
  }

  if (type === "object" && isObject(node.properties)) {
    const properties: Json = {};
    for (const [key, value] of Object.entries(node.properties)) properties[key] = sanitize(value, root, depth + 1);
    out.properties = properties;
    // A `required` name that is not a property is an error for Gemini, so only keep real ones.
    const required = Array.isArray(node.required) ? node.required.filter((r): r is string => typeof r === "string" && r in properties) : [];
    if (required.length > 0) out.required = required;
  }
  if (type === "array") out.items = sanitize(Array.isArray(node.items) ? node.items[0] : node.items, root, depth + 1);
  if (nullable) out.nullable = true;

  const description = [typeof node.description === "string" ? node.description : "", ...note, ...hints(node, folded)];
  const text = [description[0], description.slice(1).length > 0 ? `(${description.slice(1).join("; ")})` : ""].filter(Boolean).join(" ");
  if (text) out.description = text;
  return out;
}

/**
 * The `parameters` value for one tool, or undefined when the tool takes no arguments. Gemini rejects
 * an object with an empty `properties`, and OpenAI-style APIs accept a function without
 * `parameters`, so "no arguments" is expressed by leaving the key out.
 */
export function toFunctionParameters(inputSchema: unknown): Json | undefined {
  const cleaned = sanitize(inputSchema, inputSchema, 0);
  const properties = cleaned.properties;
  if (cleaned.type !== "object" || !isObject(properties) || Object.keys(properties).length === 0) return undefined;
  return cleaned;
}
