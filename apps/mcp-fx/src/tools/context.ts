import type { RateSource } from "../fx/types.js";
import type { Logger } from "../logger.js";

/** Everything a tool needs. Passed in (not imported) so tests can supply a fake rate source. */
export interface ToolContext {
  rates: RateSource;
  logger: Logger;
}
