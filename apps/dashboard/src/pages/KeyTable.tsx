import { KeyRound } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { EmptyState } from "@/components/EmptyState";
import { QueryError } from "@/components/QueryError";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime, relativeTime } from "@/lib/format";
import { useRevokeKey } from "@/lib/queries";
import type { ApiKeyRow } from "@/lib/types";

interface Props {
  keys: ApiKeyRow[] | undefined;
  isPending: boolean;
  error: unknown;
  onRetry: () => void;
  emptyText: string;
}

// Shared by "My key" and by the Team page's per-user view. Shows a key's prefix, never the key.
export function KeyTable({ keys, isPending, error, onRetry, emptyText }: Props) {
  const revoke = useRevokeKey();
  const [target, setTarget] = useState<ApiKeyRow | null>(null);

  if (isPending) return <div className="space-y-2">{[0, 1].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>;
  if (error) return <QueryError error={error} onRetry={onRetry} />;
  if (!keys || keys.length === 0) return <EmptyState icon={KeyRound} title="No keys" description={emptyText} />;

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Key</TableHead>
            <TableHead>Created</TableHead>
            <TableHead>Last used</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-24" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {keys.map((k) => (
            <TableRow key={k.id}>
              <TableCell className="font-medium">{k.name}</TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">{k.keyPrefix}…</TableCell>
              <TableCell className="text-muted-foreground" title={formatDateTime(k.createdAt)}>{relativeTime(k.createdAt)}</TableCell>
              <TableCell className="text-muted-foreground">{relativeTime(k.lastUsedAt)}</TableCell>
              <TableCell>{k.revokedAt ? <Badge variant="neutral">Revoked</Badge> : <Badge variant="success">Active</Badge>}</TableCell>
              <TableCell className="text-right">
                {!k.revokedAt && (
                  <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setTarget(k)}>
                    Revoke
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(open) => !open && setTarget(null)}
        title={`Revoke "${target?.name ?? ""}"?`}
        description="Anything using this key stops working immediately, on its next request. A revoked key cannot be restored; a new one has to be created."
        confirmLabel="Revoke key"
        pending={revoke.isPending}
        onConfirm={() => (target ? revoke.mutateAsync(target.id).catch(() => undefined) : undefined)}
      />
    </>
  );
}
