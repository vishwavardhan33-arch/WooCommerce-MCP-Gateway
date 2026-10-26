import { Router, type CookieOptions } from "express";
import { z } from "zod";
import { currentUser, sessionToken } from "../auth/guards.js";
import { login } from "../auth/login.js";
import { SESSION_COOKIE, createSession, deleteSession } from "../auth/sessions.js";
import { parse } from "../http.js";
import { emailSchema } from "../validation.js";
import type { RouteDeps } from "./deps.js";

// No min-length rule here: the password POLICY applies when a password is SET, and an old account
// must still be able to log in. We only cap the size.
const loginBody = z.object({ email: emailSchema, password: z.string().min(1).max(128) });

export function authRoutes({ db, config, requireLogin }: RouteDeps): Router {
  const router = Router();

  // The same options must be used to set and to clear a cookie, or the browser keeps the old one.
  // httpOnly: JavaScript on the page cannot read it, so an XSS bug cannot steal the session.
  // sameSite lax: the browser does not send it on cross-site POSTs, which blocks CSRF.
  // secure: only over https (turned off for local http, see COOKIE_SECURE).
  const cookieOptions: CookieOptions = { httpOnly: true, sameSite: "lax", secure: config.COOKIE_SECURE, path: "/" };

  router.post("/login", async (req, res) => {
    const { email, password } = parse(loginBody, req.body);
    const user = await login(db, email, password);
    const { token } = await createSession(db, config.SESSION_SECRET, user.id, config.SESSION_TTL_HOURS);
    res.cookie(SESSION_COOKIE, token, { ...cookieOptions, maxAge: config.SESSION_TTL_HOURS * 3_600_000 });
    res.json({ user });
  });

  // Needs no guard: logging out when you are already logged out is fine, and it must always work.
  router.post("/logout", async (req, res) => {
    const token = sessionToken(req);
    if (token) await deleteSession(db, config.SESSION_SECRET, token);
    res.clearCookie(SESSION_COOKIE, cookieOptions);
    res.status(204).end();
  });

  // The dashboard calls this on load to learn "am I logged in, and as what?".
  router.get("/me", requireLogin, (_req, res) => {
    res.json({ user: currentUser(res) });
  });

  return router;
}
