import { sha256Hex } from "../auth/tokens.js";

// Clients see ONE flat tool list made of many servers' tools, so every tool name carries its server:
//   <slug>__<tool>      e.g.  shop__list_products
// Limits come from the MCP clients we target: names up to 64 characters from [A-Za-z0-9_-].
export const MAX_TOOL_NAME_LENGTH = 64;
const VALID_NAME = /^[A-Za-z0-9_-]+$/;

// A slug must NOT contain "__", otherwise "where does the slug end?" would be ambiguous when routing.
// Lower-case letters, digits and single hyphens, at most 32 characters (leaves room for the tool name).
// It must START WITH A LETTER: published tool names begin with the slug, and some model APIs
// (Gemini) reject function names that start with a digit.
export const SLUG_PATTERN = /^(?=.{1,32}$)[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

const SEPARATOR = "__";

export function namespacedName(slug: string, tool: string): string {
  const full = `${slug}${SEPARATOR}${tool}`;
  if (full.length <= MAX_TOOL_NAME_LENGTH && VALID_NAME.test(full)) return full;

  // The name needs fixing (too long, or has characters clients reject). Fixing alone could make two
  // DIFFERENT upstream names identical ("a.b" and "a_b" both become "a_b"; two long names can share
  // their first 55 characters). So we append a short hash of the ORIGINAL name: different originals
  // get different hashes, and the same original always gets the same name (stable between restarts).
  const hash = sha256Hex(full).slice(0, 8);
  const cleaned = full.replace(/[^A-Za-z0-9_-]/g, "_");
  return `${cleaned.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
}

// Routing looks at the part before the FIRST "__": that is the slug (slugs never contain "__").
// We do not parse the tool part back out of the name, because truncated names cannot be reversed;
// the server's own cache maps the full name to the original tool name instead.
export function slugOf(name: string): string | undefined {
  const index = name.indexOf(SEPARATOR);
  return index > 0 ? name.slice(0, index) : undefined;
}

export const describeWithSlug = (slug: string, description: string | undefined): string =>
  description ? `[${slug}] ${description}` : `[${slug}]`;
