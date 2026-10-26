// The copy-paste setup instructions on the "My key" page. Pure functions: given the gateway URL and
// a key (or a placeholder), produce the text. The real key only ever appears in these strings for the
// few moments right after it is created.
export const KEY_PLACEHOLDER = "YOUR_API_KEY";
const NAME = "team-gateway";

export const claudeCodeSnippet = (url: string, key: string): string =>
  `claude mcp add --transport http ${NAME} ${url} --header "Authorization: Bearer ${key}"`;

// Cursor reads ~/.cursor/mcp.json (all projects) or .cursor/mcp.json (one project).
export const cursorSnippet = (url: string, key: string): string =>
  JSON.stringify({ mcpServers: { [NAME]: { url, headers: { Authorization: `Bearer ${key}` } } } }, null, 2);

// MCP Inspector is a web app you start with npx; the connection is filled in on its left panel.
export const inspectorCommand = "npx @modelcontextprotocol/inspector";
export const inspectorFields = (url: string, key: string): { label: string; value: string }[] => [
  { label: "Transport Type", value: "Streamable HTTP" },
  { label: "URL", value: url },
  { label: "Authentication > Header name", value: "Authorization" },
  { label: "Authentication > Header value", value: `Bearer ${key}` },
];
