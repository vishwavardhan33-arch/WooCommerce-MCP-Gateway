import type { RequestHandler, Response } from "express";
import { authenticateApiKey } from "../auth/apiKeys.js";
import { API_KEY_TAG } from "../auth/tokens.js";
import type { Db } from "../db/client.js";
import type { Logger } from "../logger.js";
import type { Principal } from "./principal.js";
import { rpcError } from "./rpc.js";

// The one place the principal is read back out of res.locals (untyped), like currentUser() for REST.
export function getPrincipal(res: Response): Principal {
  const principal = res.locals.principal as Principal | undefined;
  if (!principal) throw new Error("getPrincipal() called on a route without apiKeyAuth");
  return principal;
}

// Authenticates EVERY request, not once per connection: the endpoint is stateless, so a revoked key
// stops working on the very next request.
export function apiKeyAuth(db: Db, logger: Logger): RequestHandler {
  return async (req, res, next) => {
    const header = req.header("authorization");
    const key = /^Bearer (.+)$/i.exec(header ?? "")?.[1]?.trim();
    const found = key ? await authenticateApiKey(db, key) : undefined;

    if (!found) {
      // Log WHY, never the key. Only the display prefix of something that looks like one of our keys
      // is logged (it is already shown in the dashboard), so a log reader can tell which key is
      // being tried without being able to use it.
      logger.warn(
        {
          reason: !header ? "missing_authorization_header" : !key ? "not_a_bearer_token" : "unknown_or_revoked_key",
          keyPrefix: key?.startsWith(API_KEY_TAG) ? key.slice(0, 12) : undefined,
          ip: req.ip,
          path: req.path,
        },
        "mcp auth failed",
      );
      res
        .status(401)
        .set("WWW-Authenticate", "Bearer")
        .json(rpcError(-32001, "Unauthorized: missing, invalid or revoked API key"));
      return;
    }

    res.locals.principal = { userId: found.userId, role: found.role, apiKeyId: found.keyId, source: "mcp" } satisfies Principal;
    next();
  };
}
