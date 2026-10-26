import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "./context.js";
import { guard, NotesError } from "./result.js";

const limitSchema = z.number().int().min(1).max(100).default(20).describe("Maximum number of notes to return.");

export function registerNoteTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "create_note",
    {
      title: "Create note",
      description: "Save a new note. Returns its id, which get_note needs to read the whole note later.",
      inputSchema: {
        title: z.string().trim().min(1).max(200).describe("Short title."),
        body: z.string().min(1).max(10_000).describe("The note text."),
      },
      // Additive (adds a note, overwrites nothing) but not idempotent: calling it twice creates two.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ title, body }) =>
      guard(ctx, "create_note", () => ({ created: ctx.store.create(title, body, ctx.now().toISOString()) })),
  );

  server.registerTool(
    "list_notes",
    {
      title: "List notes",
      description:
        "List notes, newest first. Each entry has id, title, the first 100 characters of the text and the creation time. " +
        "Use get_note for the full text and `offset` to page back to older notes.",
      inputSchema: {
        limit: limitSchema,
        offset: z.number().int().min(0).default(0).describe("How many of the newest notes to skip."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ limit, offset }) =>
      guard(ctx, "list_notes", () => {
        const notes = ctx.store.list(limit, offset);
        return {
          count: notes.length,
          notes,
          ...(notes.length === limit ? { note: "There may be older notes; raise `offset` to see them." } : {}),
        };
      }),
  );

  server.registerTool(
    "get_note",
    {
      title: "Get note",
      description: "Get one note with its full text, by id.",
      inputSchema: { id: z.number().int().positive().describe("The note id, as returned by create_note, list_notes or search_notes.") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) =>
      guard(ctx, "get_note", () => {
        const note = ctx.store.get(id);
        if (!note) throw new NotesError(`There is no note with id ${id}. Use list_notes or search_notes to find ids.`);
        return { note };
      }),
  );

  server.registerTool(
    "search_notes",
    {
      title: "Search notes",
      description:
        "Find notes whose title or text contains the given text (case-insensitive), newest first. " +
        "Returns the same short entries as list_notes; use get_note for the full text.",
      inputSchema: {
        query: z.string().trim().min(1).max(200).describe("Text to look for."),
        limit: limitSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit }) =>
      guard(ctx, "search_notes", () => {
        const notes = ctx.store.search(query, limit);
        return { count: notes.length, notes, ...(notes.length === limit ? { note: "There may be more matches; narrow the query." } : {}) };
      }),
  );
}
