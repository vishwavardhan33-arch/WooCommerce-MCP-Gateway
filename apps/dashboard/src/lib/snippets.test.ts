import { describe, expect, it } from "vitest";
import { claudeCodeSnippet, cursorSnippet, inspectorFields, KEY_PLACEHOLDER } from "./snippets.js";

const URL = "https://gateway.example.com/mcp";

describe("connect snippets", () => {
  it("builds the Claude Code command with the HTTP transport and the bearer header", () => {
    expect(claudeCodeSnippet(URL, "mcp_abc")).toBe(
      'claude mcp add --transport http team-gateway https://gateway.example.com/mcp --header "Authorization: Bearer mcp_abc"',
    );
  });

  it("builds valid Cursor mcp.json", () => {
    const parsed = JSON.parse(cursorSnippet(URL, "mcp_abc"));
    expect(parsed).toEqual({ mcpServers: { "team-gateway": { url: URL, headers: { Authorization: "Bearer mcp_abc" } } } });
  });

  it("tells MCP Inspector which fields to fill", () => {
    const fields = Object.fromEntries(inspectorFields(URL, "mcp_abc").map((f) => [f.label, f.value]));
    expect(fields["Transport Type"]).toBe("Streamable HTTP");
    expect(fields.URL).toBe(URL);
    expect(fields["Authentication > Header value"]).toBe("Bearer mcp_abc");
  });

  it("with the placeholder, no real key can be present", () => {
    for (const text of [claudeCodeSnippet(URL, KEY_PLACEHOLDER), cursorSnippet(URL, KEY_PLACEHOLDER)]) {
      expect(text).toContain(KEY_PLACEHOLDER);
      expect(text).not.toMatch(/mcp_[A-Za-z0-9_-]{20,}/);
    }
  });
});
