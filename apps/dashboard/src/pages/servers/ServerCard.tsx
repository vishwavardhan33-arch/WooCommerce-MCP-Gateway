import { Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { StatusBadge } from "@/components/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { elapsedSince, formatDuration } from "@/lib/format";
import { useDeleteServer, useToggleServer } from "@/lib/queries";
import type { Server } from "@/lib/types";

function statusLine(server: Server): string {
  if (!server.enabled) return "Not contacted while disabled";
  if (server.status === "up") return `Connected for ${elapsedSince(server.statusSince)}`;
  if (server.status === "down") return `Down for ${elapsedSince(server.statusSince)}`;
  return "Waiting for the first health check";
}

export function ServerCard({ server, isAdmin, onEdit }: { server: Server; isAdmin: boolean; onEdit: (server: Server) => void }) {
  const toggle = useToggleServer();
  const remove = useDeleteServer();
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <Card className="flex flex-col">
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0 pb-3">
        <div className="min-w-0 space-y-1">
          <CardTitle className="truncate font-mono">{server.slug}</CardTitle>
          <CardDescription className="truncate" title={server.url}>{server.url}</CardDescription>
        </div>
        <StatusBadge status={server.status} enabled={server.enabled} statusSince={server.statusSince} lastError={server.lastError} />
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline">{server.toolCount} {server.toolCount === 1 ? "tool" : "tools"}</Badge>
          <Badge variant="outline">{server.authType === "bearer" ? "Bearer auth" : "No auth"}</Badge>
          <Badge variant="outline">Timeout {formatDuration(server.timeoutMs)}</Badge>
        </div>
        <p className="text-xs text-muted-foreground">{statusLine(server)}</p>
      </CardContent>
      {isAdmin && (
        <CardFooter className="mt-auto justify-between border-t py-3">
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={server.enabled}
              disabled={toggle.isPending}
              onCheckedChange={(enabled) => toggle.mutate({ id: server.id, enabled })}
              aria-label={`${server.enabled ? "Disable" : "Enable"} ${server.slug}`}
            />
            {server.enabled ? "Enabled" : "Disabled"}
          </label>
          <div className="flex gap-1">
            <Button variant="ghost" size="icon" aria-label={`Edit ${server.slug}`} onClick={() => onEdit(server)}>
              <Pencil />
            </Button>
            <Button variant="ghost" size="icon" aria-label={`Delete ${server.slug}`} className="text-destructive hover:text-destructive" onClick={() => setConfirmOpen(true)}>
              <Trash2 />
            </Button>
          </div>
        </CardFooter>
      )}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Delete ${server.slug}?`}
        description="Its tools disappear from every client right away and its settings, including the saved credential, are removed. This cannot be undone."
        confirmLabel="Delete server"
        pending={remove.isPending}
        onConfirm={() => remove.mutateAsync(server.id).catch(() => undefined)}
      />
    </Card>
  );
}

export function ServerCardSkeleton() {
  return (
    <Card>
      <CardHeader className="space-y-2">
        <div className="flex justify-between gap-3">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-5 w-24 rounded-full" />
        </div>
        <Skeleton className="h-4 w-48" />
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-5 w-20 rounded-full" />
        </div>
        <Skeleton className="h-3 w-36" />
      </CardContent>
    </Card>
  );
}
