// The JSON-RPC error body MCP clients expect for HTTP-level failures (they cannot read our REST
// style {error: "..."} bodies).
export const rpcError = (code: number, message: string) => ({ jsonrpc: "2.0" as const, error: { code, message }, id: null });
