import type { NotesStore } from "../notes/store.js";
import type { Logger } from "../logger.js";

/** Everything a tool needs. Passed in (not imported) so tests can supply an in-memory store and a fixed clock. */
export interface ToolContext {
  store: NotesStore;
  logger: Logger;
  now: () => Date;
}
