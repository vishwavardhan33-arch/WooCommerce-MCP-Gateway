// Small display helpers, kept pure so they are easy to test.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relativeTime(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "never";
  const diff = now - new Date(iso).getTime();
  if (Number.isNaN(diff)) return "unknown";
  if (diff < 0) return "just now"; // a clock a few seconds ahead of ours
  if (diff < 10_000) return "just now";
  if (diff < MINUTE) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} h ago`;
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} d ago`;
  return new Date(iso).toLocaleDateString();
}

// "How long has it been this way": 42s, 5 min, 3 h, 2 d (no "ago", for sentences like "down for 5 min").
export function elapsedSince(iso: string, now: number = Date.now()): string {
  const diff = now - new Date(iso).getTime();
  if (Number.isNaN(diff)) return "an unknown time";
  if (diff < 10_000) return "a few seconds";
  if (diff < MINUTE) return `${Math.floor(diff / 1000)}s`;
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} h`;
  return `${Math.floor(diff / DAY)} d`;
}

export const formatDateTime = (iso: string): string => new Date(iso).toLocaleString();

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

export function formatPercent(part: number, total: number): string {
  if (total === 0) return "0%";
  const pct = (part / total) * 100;
  return `${pct < 10 && pct > 0 ? pct.toFixed(1) : Math.round(pct)}%`;
}

// "shop__list_products" -> { server: "shop", tool: "list_products" }, for showing the two halves differently.
export function splitToolName(name: string): { server: string | null; tool: string } {
  const i = name.indexOf("__");
  return i > 0 ? { server: name.slice(0, i), tool: name.slice(i + 2) } : { server: null, tool: name };
}
