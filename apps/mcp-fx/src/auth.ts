import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

const sha256 = (value: string) => createHash("sha256").update(value).digest();

// Static bearer token: this server is only meant to be called by the gateway, which stores the
// token as the upstream credential. Both sides are hashed before the comparison because
// timingSafeEqual needs equal-length inputs, and comparing in constant time keeps response
// timing from leaking how much of a guess was right.
export function bearerAuth(expectedToken: string): RequestHandler {
  const expected = sha256(expectedToken);
  return (req, res, next) => {
    const token = /^Bearer (.+)$/i.exec(req.header("authorization") ?? "")?.[1];
    if (token !== undefined && timingSafeEqual(sha256(token), expected)) {
      next();
      return;
    }
    res
      .status(401)
      .set("WWW-Authenticate", "Bearer")
      .json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: missing or invalid bearer token" }, id: null });
  };
}
