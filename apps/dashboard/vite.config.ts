import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the dashboard runs on :5173 and the gateway on :3000. Proxying /api (and /mcp, for
// the "Connect" snippets) makes the browser see ONE origin, exactly like production behind the
// ingress, so the session cookie works without any CORS setup.
const gateway = process.env.GATEWAY_URL ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  server: { port: 5173, proxy: { "/api": gateway, "/mcp": gateway } },
});
