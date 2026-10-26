import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM for upstream credentials stored in mcp_servers.credential_enc.
// GCM is "authenticated" encryption: besides hiding the text it detects any change to it, so a
// tampered value or a wrong key makes decryption FAIL instead of returning garbage.
//
// Stored format (base64 of): iv (12 bytes) | auth tag (16 bytes) | ciphertext
const IV_LENGTH = 12; // 96 bits: the size GCM is designed for
const TAG_LENGTH = 16;

export function encryptCredential(key: Buffer, plaintext: string): string {
  // A fresh random IV for EVERY encryption. Reusing an IV with the same key breaks GCM completely.
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

export function decryptCredential(key: Buffer, encoded: string): string {
  const raw = Buffer.from(encoded, "base64");
  if (raw.length < IV_LENGTH + TAG_LENGTH) throw new Error("credential_enc is too short to be valid");
  // authTagLength pins the tag size so a shortened (weaker) tag is rejected.
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV_LENGTH), { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH));
  // final() is where the tag is verified; it throws if the key or the data is wrong.
  return Buffer.concat([decipher.update(raw.subarray(IV_LENGTH + TAG_LENGTH)), decipher.final()]).toString("utf8");
}
