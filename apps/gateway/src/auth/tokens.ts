import { createHash, createHmac, randomBytes } from "node:crypto";

// 32 random bytes = 256 bits from the operating system's secure random source, written as URL-safe
// text (letters, digits, - and _). Nobody can guess one, so none of the stored forms below needs a
// slow password hash.
export const randomToken = (): string => randomBytes(32).toString("base64url");

export const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

// Keyed hash. Used for session tokens so that stealing the database is not enough: without
// SESSION_SECRET an attacker cannot compute the hash of a cookie they invent.
export const hmacSha256Hex = (secret: string, value: string): string =>
  createHmac("sha256", secret).update(value).digest("hex");

// ---- API keys ----
// Format: "mcp_" + 256 random bits. The "mcp_" tag makes a leaked key recognisable (secret scanners,
// grep) and lets us reject obviously wrong strings without a database query.
export const API_KEY_TAG = "mcp_";
// "mcp_" + 8 random characters (48 bits): enough to tell keys apart, useless for guessing the rest.
const PREFIX_LENGTH = API_KEY_TAG.length + 8;

// Why plain sha256 and not argon2: argon2 is slow ON PURPOSE to protect LOW-entropy secrets (human
// passwords). An API key is 256 random bits, so brute force is impossible however fast the hash
// is, and a fast hash lets us check a key on every request without burning CPU.
export const hashApiKey = (key: string): string => sha256Hex(key);

export function generateApiKey(): { key: string; keyPrefix: string; keyHash: string } {
  const key = `${API_KEY_TAG}${randomToken()}`;
  return { key, keyPrefix: key.slice(0, PREFIX_LENGTH), keyHash: hashApiKey(key) };
}
