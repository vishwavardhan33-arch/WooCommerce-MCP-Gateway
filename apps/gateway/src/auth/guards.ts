import type { Request, RequestHandler, Response } from "express";
import type { Db } from "../db/client.js";
import type { Role } from "../db/schema.js";
import { SESSION_COOKIE, findSessionUser } from "./sessions.js";
import type { AuthUser } from "./types.js";

// Express does not parse cookies, and we need exactly one, so: split the header on ";" and pick
// the named one. Our token is base64url (no ";" or "=" inside), so no decoding is needed.
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

export const sessionToken = (req: Request): string | undefined => readCookie(req.header("cookie"), SESSION_COOKIE);

// The one place that reads the user back out of res.locals. res.locals is untyped, so the cast
// lives here and nowhere else. It throws if requireSession did not run first: that is a bug in how
// the routes were wired, not something a client can cause.
export function currentUser(res: Response): AuthUser {
  const user = res.locals.user as AuthUser | undefined;
  if (!user) throw new Error("currentUser() called on a route without requireSession");
  return user;
}

// Guard 1, AUTHENTICATION ("who are you?"): needs a valid session cookie, and puts the user on
// res.locals for the handlers after it.
export function requireSession(db: Db, secret: string): RequestHandler {
  return async (req, res, next) => {
    const token = sessionToken(req);
    const user = token ? await findSessionUser(db, secret, token) : undefined;
    if (!user) {
      res.status(401).json({ error: "Not logged in" });
      return;
    }
    res.locals.user = user;
    next();
  };
}

// Guard 2, AUTHORIZATION ("are you allowed?"): runs AFTER requireSession and checks the role.
// An explicit list (requireRole("admin")) rather than "at least member", so what each route allows
// is readable at the route and does not depend on an ordering of roles.
export function requireRole(...allowed: Role[]): RequestHandler {
  return (_req, res, next) => {
    const user = res.locals.user as AuthUser | undefined;
    if (!user) {
      res.status(401).json({ error: "Not logged in" });
      return;
    }
    if (!allowed.includes(user.role)) {
      res.status(403).json({ error: `This action requires the role: ${allowed.join(" or ")}` });
      return;
    }
    next();
  };
}
