// Audit records must show WHAT was called without becoming a second copy of everything users type.
// Tool arguments can hold customer names, emails, addresses, even secrets, so we store their SHAPE
// (names, types, sizes), never their text.

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

// Argument names that suggest a secret. Their values are replaced even if the shape would be harmless.
const SENSITIVE_KEY = /pass(word|wd)?|secret|token|key|auth|credential|cookie|session|bearer/i;
const MAX_KEYS = 20;
const MAX_KEY_LENGTH = 50;

type Summary = string | number | boolean | null;

function describeValue(value: unknown): Summary {
  if (value === null || value === undefined) return null;
  // Numbers and booleans (ids, limits, flags) are what makes an audit trail useful and carry little risk.
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return `string(${value.length})`;
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === "object") return `object(${Object.keys(value).length} keys)`;
  return typeof value;
}

export function summarizeArgs(args: Record<string, unknown> | undefined): Record<string, Summary> {
  const summary: Record<string, Summary> = {};
  if (!args) return summary;
  const entries = Object.entries(args);
  for (const [key, value] of entries.slice(0, MAX_KEYS)) {
    summary[key.slice(0, MAX_KEY_LENGTH)] = SENSITIVE_KEY.test(key) ? "[redacted]" : describeValue(value);
  }
  // Bound the size of the record: a client could send thousands of argument names.
  if (entries.length > MAX_KEYS) summary["..."] = `${entries.length - MAX_KEYS} more arguments`;
  return summary;
}
