import { Search } from "lucide-react";
import { useState } from "react";
import { QueryError } from "@/components/QueryError";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useTools } from "@/lib/queries";

// Everything a client of this gateway can call, grouped by the server it comes from. It shows the
// published names (shop__list_products), which are what a model or a script has to use.
export function ToolsDrawer({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const tools = useTools(open);
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();

  const groups = (tools.data ?? []).map((g) => ({
    ...g,
    tools: g.tools.filter((t) => !needle || t.name.toLowerCase().includes(needle) || t.description.toLowerCase().includes(needle)),
  }));
  const visible = needle ? groups.filter((g) => g.tools.length > 0) : groups;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="max-w-lg">
        <SheetHeader>
          <SheetTitle>Available tools</SheetTitle>
          <SheetDescription>What your MCP clients and the chat can call right now.</SheetDescription>
        </SheetHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter tools" className="pl-9" aria-label="Filter tools" />
        </div>
        <div className="-mr-2 flex-1 space-y-6 overflow-y-auto pr-2">
          {tools.isPending && (
            <div className="space-y-3">
              {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full" />)}
            </div>
          )}
          {tools.isError && <QueryError error={tools.error} onRetry={() => void tools.refetch()} />}
          {tools.data && visible.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">{needle ? "No tool matches that filter." : "No servers are enabled yet."}</p>
          )}
          {visible.map((group) => (
            <section key={group.slug} className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="font-mono text-sm font-semibold">{group.slug}</h3>
                <Badge variant={group.status === "up" ? "success" : group.status === "down" ? "destructive" : "neutral"}>
                  {group.status === "up" ? "Connected" : group.status === "down" ? "Unreachable" : "Checking"}
                </Badge>
              </div>
              {group.status !== "up" && group.tools.length === 0 && (
                <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                  {group.status === "down" ? "This server is unreachable, so its tools are hidden until it answers again." : "Waiting for this server's first health check."}
                </p>
              )}
              <ul className="space-y-2">
                {group.tools.map((t) => (
                  <li key={t.name} className="rounded-md border bg-background p-3">
                    <p className="break-all font-mono text-xs font-medium">{t.name}</p>
                    {t.description && <p className="mt-1 text-xs text-muted-foreground">{t.description}</p>}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
