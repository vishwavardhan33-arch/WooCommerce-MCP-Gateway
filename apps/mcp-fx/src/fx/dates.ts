// "2026-02-30" matches the shape YYYY-MM-DD but is not a real day. JavaScript silently rolls such
// dates over (to 2026-03-02), so a real date is one that survives a round trip unchanged.
export function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}
