import { z } from "zod";

// An error we EXPECT (bad input, wrong password, not allowed). The error handler in app.ts turns it
// into the HTTP status and message below. Anything that is not an HttpError is a bug and becomes
// a generic 500, so internal details never reach the client.
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// Validates untrusted input (request bodies) with a zod schema and returns the typed result.
export function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`);
    throw new HttpError(400, problems.join("; "));
  }
  return result.data;
}
