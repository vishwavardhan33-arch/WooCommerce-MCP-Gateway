import { ChevronDown, ChevronRight, RefreshCw, ScrollText } from "lucide-react";
import { Fragment, useState } from "react";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { QueryError } from "@/components/QueryError";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input, NativeSelect } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCurrentUser } from "@/lib/auth";
import { formatDateTime, formatDuration, formatPercent, relativeTime } from "@/lib/format";
import { useAudit, useAuditSummary, useServers, useUsers } from "@/lib/queries";
import type { AuditEntry, AuditFilters, AuditStatus } from "@/lib/types";

const PAGE_SIZE = 25;
const WINDOWS = [
  { hours: 1, label: "Last hour" },
  { hours: 24, label: "Last 24 hours" },
  { hours: 168, label: "Last 7 days" },
];

const statusVariant: Record<AuditStatus, "success" | "destructive" | "warning"> = { ok: "success", error: "destructive", denied: "warning" };

export function AuditPage() {
  const isAdmin = useCurrentUser().role === "admin";
  const [filters, setFilters] = useState<AuditFilters>({ server: "", status: "", source: "", tool: "", userId: "", limit: PAGE_SIZE, offset: 0 });
  const [hours, setHours] = useState(24);
  const [auto, setAuto] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  const audit = useAudit(filters, auto);
  const summary = useAuditSummary(hours, auto);
  const servers = useServers();
  const users = useUsers(isAdmin);

  // Changing a filter returns to the first page.
  const setFilter = (patch: Partial<AuditFilters>) => setFilters((f) => ({ ...f, ...patch, offset: 0 }));
  const entries = audit.data ?? [];
  const refreshing = audit.isFetching || summary.isFetching;

  return (
    <>
      <PageHeader
        title="Audit"
        description={isAdmin ? "Every tool call made through the gateway, by anyone, with how long it took and how it ended." : "Your own tool calls through the gateway, with how long they took and how they ended."}
        actions={
          <>
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <Switch checked={auto} onCheckedChange={setAuto} aria-label="Auto-refresh" />
              Auto-refresh
            </label>
            <Button variant="outline" size="sm" onClick={() => { void audit.refetch(); void summary.refetch(); }}>
              <RefreshCw className={refreshing ? "animate-spin" : ""} /> Refresh
            </Button>
          </>
        }
      />

      <section aria-labelledby="summary-title" className="mb-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="summary-title" className="text-sm font-medium text-muted-foreground">Server health</h2>
          <NativeSelect className="h-8 w-40" value={hours} onChange={(e) => setHours(Number(e.target.value))} aria-label="Time window">
            {WINDOWS.map((w) => <option key={w.hours} value={w.hours}>{w.label}</option>)}
          </NativeSelect>
        </div>
        {summary.isPending && <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-28" />)}</div>}
        {summary.isError && <QueryError error={summary.error} onRetry={() => void summary.refetch()} />}
        {summary.data && summary.data.length === 0 && <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No tool calls in this period.</p>}
        {summary.data && summary.data.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {summary.data.map((s) => (
              <Card key={s.server}>
                <CardContent className="space-y-3 p-5">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-sm font-semibold">{s.server}</span>
                    <Badge variant={s.errors > 0 ? "destructive" : "success"}>{formatPercent(s.errors, s.calls)} errors</Badge>
                  </div>
                  <dl className="grid grid-cols-3 gap-2 text-sm">
                    <Stat label="Calls" value={String(s.calls)} />
                    <Stat label="Avg" value={formatDuration(s.avgMs)} />
                    <Stat label="p95" value={formatDuration(s.p95Ms)} />
                  </dl>
                  {s.denied > 0 && <p className="text-xs text-warning">{s.denied} blocked by policy</p>}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <NativeSelect value={filters.server} onChange={(e) => setFilter({ server: e.target.value })} aria-label="Filter by server">
          <option value="">All servers</option>
          {servers.data?.map((s) => <option key={s.id} value={s.slug}>{s.slug}</option>)}
        </NativeSelect>
        <NativeSelect value={filters.status} onChange={(e) => setFilter({ status: e.target.value })} aria-label="Filter by status">
          <option value="">Any status</option>
          <option value="ok">ok</option>
          <option value="error">error</option>
          <option value="denied">denied</option>
        </NativeSelect>
        <NativeSelect value={filters.source} onChange={(e) => setFilter({ source: e.target.value })} aria-label="Filter by source">
          <option value="">Any source</option>
          <option value="mcp">API key (MCP client)</option>
          <option value="chat">Chat</option>
        </NativeSelect>
        <Input value={filters.tool} onChange={(e) => setFilter({ tool: e.target.value })} placeholder="Tool name, e.g. list_products" aria-label="Filter by tool name" />
        {isAdmin && (
          <NativeSelect value={filters.userId} onChange={(e) => setFilter({ userId: e.target.value })} aria-label="Filter by user">
            <option value="">Everyone</option>
            {users.data?.map((u) => <option key={u.id} value={u.id}>{u.email}</option>)}
          </NativeSelect>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          {audit.isPending && <div className="space-y-2 p-4">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>}
          {audit.isError && <div className="p-4"><QueryError error={audit.error} onRetry={() => void audit.refetch()} /></div>}
          {audit.data && entries.length === 0 && (
            <div className="p-6">
              <EmptyState icon={ScrollText} title="Nothing here" description={filters.server || filters.status || filters.source || filters.tool || filters.userId ? "No calls match these filters." : "Tool calls appear here as soon as someone makes one."} />
            </div>
          )}
          {entries.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>When</TableHead>
                  {isAdmin && <TableHead>User</TableHead>}
                  <TableHead>Via</TableHead>
                  <TableHead>Tool</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Duration</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((e) => (
                  <AuditRow key={e.id} entry={e} isAdmin={isAdmin} open={expanded === e.id} onToggle={() => setExpanded(expanded === e.id ? null : e.id)} />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
        <span>{entries.length > 0 ? `Showing ${filters.offset + 1}-${filters.offset + entries.length}` : ""}</span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={filters.offset === 0} onClick={() => setFilters((f) => ({ ...f, offset: Math.max(0, f.offset - PAGE_SIZE) }))}>
            Newer
          </Button>
          <Button variant="outline" size="sm" disabled={entries.length < PAGE_SIZE} onClick={() => setFilters((f) => ({ ...f, offset: f.offset + PAGE_SIZE }))}>
            Older
          </Button>
        </div>
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

function AuditRow({ entry, isAdmin, open, onToggle }: { entry: AuditEntry; isAdmin: boolean; open: boolean; onToggle: () => void }) {
  const d = entry.detail;
  const via = d?.source === "chat" ? "Chat" : entry.keyName ? `${entry.keyName}` : "API key";
  const args = d ? Object.entries(d.args) : [];

  return (
    <Fragment>
      <TableRow className="cursor-pointer" onClick={onToggle}>
        <TableCell>
          <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={open ? "Hide details" : "Show details"} aria-expanded={open}>
            {open ? <ChevronDown /> : <ChevronRight />}
          </Button>
        </TableCell>
        <TableCell className="whitespace-nowrap text-muted-foreground" title={formatDateTime(entry.createdAt)}>{relativeTime(entry.createdAt)}</TableCell>
        {isAdmin && <TableCell className="max-w-40 truncate">{entry.userEmail ?? "(deleted user)"}</TableCell>}
        <TableCell className="max-w-40 truncate text-muted-foreground">{via}</TableCell>
        <TableCell className="font-mono text-xs">{entry.target}</TableCell>
        <TableCell>
          {d ? (
            <Badge variant={statusVariant[d.status]}>{d.status}</Badge>
          ) : (
            <Badge variant="neutral">{entry.ok ? "ok" : "failed"}</Badge>
          )}
        </TableCell>
        <TableCell className="text-right tabular-nums text-muted-foreground">{d ? formatDuration(d.durationMs) : "-"}</TableCell>
      </TableRow>
      {open && (
        <TableRow className="bg-muted/30 hover:bg-muted/30">
          <TableCell />
          <TableCell colSpan={isAdmin ? 6 : 5} className="space-y-3 py-4 text-sm">
            <div className="grid gap-x-8 gap-y-1 text-xs sm:grid-cols-2">
              <p><span className="text-muted-foreground">Time: </span>{formatDateTime(entry.createdAt)}</p>
              <p><span className="text-muted-foreground">Source: </span>{d?.source === "chat" ? "Chat" : `API key${entry.keyPrefix ? ` ${entry.keyPrefix}…` : ""}`}</p>
              <p><span className="text-muted-foreground">Server: </span>{d?.server ?? "-"}</p>
              <p><span className="text-muted-foreground">Tool: </span>{d?.tool ?? "-"}</p>
            </div>
            {d?.error && (
              <div>
                <p className="mb-1 text-xs font-medium text-destructive">Error</p>
                <p className="break-words rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs">{d.error}</p>
              </div>
            )}
            <div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <p className="mb-1 w-fit cursor-help text-xs font-medium text-muted-foreground underline decoration-dotted">Arguments (shape only)</p>
                </TooltipTrigger>
                <TooltipContent>Argument values are not stored: only their names, types and sizes, so the audit log never holds customer data or secrets.</TooltipContent>
              </Tooltip>
              {args.length === 0 ? (
                <p className="text-xs text-muted-foreground">No arguments.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {args.map(([k, v]) => (
                    <Badge key={k} variant="outline" className="font-mono">{k}: {String(v)}</Badge>
                  ))}
                </div>
              )}
            </div>
          </TableCell>
        </TableRow>
      )}
    </Fragment>
  );
}
