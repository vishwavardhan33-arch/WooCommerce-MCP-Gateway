import { z } from "zod";

// Emails are stored lower-case and trimmed, so "Ann@x.com" and "ann@x.com " are the same person
// and the plain UNIQUE constraint on users.email is enough (no citext extension needed).
export const emailSchema = z.string().trim().toLowerCase().email().max(254);

// Length is the rule that matters most for passwords. The upper bound stops someone from sending
// a 10 MB "password" to make us burn time hashing it.
export const passwordSchema = z
  .string()
  .min(12, "must be at least 12 characters")
  .max(128, "must be at most 128 characters");
