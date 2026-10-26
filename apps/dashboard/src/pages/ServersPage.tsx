import { Plus, Server as ServerIcon, Wrench } from "lucide-react";
import { useState } from "react";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { QueryError } from "@/components/QueryError";
import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/lib/auth";
import { useServers } from "@/lib/queries";
import type { Server } from "@/lib/types";
import { ServerCard, ServerCardSkeleton } from "./servers/ServerCard";
import { ServerFormDialog } from "./servers/ServerFormDialog";
import { ToolsDrawer } from "./servers/ToolsDrawer";

export function ServersPage() {
  const isAdmin = useCurrentUser().role === "admin";
  const servers = useServers(); // refreshes itself every 5 seconds
  const [target, setTarget] = useState<Server | "new" | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);

  return (
    <>
      <PageHeader
        title="Servers"
        description={isAdmin ? "The MCP servers behind this gateway. Status refreshes every few seconds." : "The MCP servers your tools come from. Status refreshes every few seconds."}
        actions={
          <>
            <Button variant="outline" onClick={() => setToolsOpen(true)}>
              <Wrench /> Tools
            </Button>
            {isAdmin && (
              <Button onClick={() => setTarget("new")}>
                <Plus /> Add server
              </Button>
            )}
          </>
        }
      />

      {servers.isPending && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => <ServerCardSkeleton key={i} />)}
        </div>
      )}
      {servers.isError && <QueryError error={servers.error} onRetry={() => void servers.refetch()} />}
      {servers.data && servers.data.length === 0 && (
        <EmptyState
          icon={ServerIcon}
          title="No servers yet"
          description={isAdmin ? "Add your first MCP server to give your team tools to work with." : "An administrator has not added any servers yet."}
          action={isAdmin && <Button onClick={() => setTarget("new")}><Plus /> Add server</Button>}
        />
      )}
      {servers.data && servers.data.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {servers.data.map((server) => (
            <ServerCard key={server.id} server={server} isAdmin={isAdmin} onEdit={setTarget} />
          ))}
        </div>
      )}

      <ServerFormDialog target={target} onClose={() => setTarget(null)} />
      <ToolsDrawer open={toolsOpen} onOpenChange={setToolsOpen} />
    </>
  );
}
