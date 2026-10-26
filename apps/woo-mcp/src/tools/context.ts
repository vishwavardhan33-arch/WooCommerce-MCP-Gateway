import type { Logger } from "../logger.js";
import type { WcClient } from "../wc/client.js";

/** Everything a tool needs. Passed in (not imported) so tests can supply a fake store and a fixed clock. */
export interface ToolContext {
  wc: WcClient;
  logger: Logger;
  now: () => Date;
}
