import { ChevronDown, ChevronRight, Loader2, Mail, Plus, Users } from "lucide-react";
import { Fragment, useState, type FormEvent } from "react";
import { CopyButton } from "@/components/CopyButton";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { QueryError } from "@/components/QueryError";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { errorMessage } from "@/lib/api";
import { useCurrentUser } from "@/lib/auth";
import { formatDateTime, relativeTime } from "@/lib/format";
import { useChangeRole, useCreateInvite, useInvites, useUserKeys, useUsers } from "@/lib/queries";
import type { InviteRow, Role, TeamUser } from "@/lib/types";
import { KeyTable } from "./KeyTable";

export function TeamPage() {
  const me = useCurrentUser();
  const users = useUsers();
  const invites = useInvites();
  const changeRole = useChangeRole();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <>
      <PageHeader
        title="Team"
        description="Invite people, choose what they can do, and see or revoke the keys they use to connect."
        actions={
          <Button onClick={() => setInviteOpen(true)}>
            <Plus /> Invite member
          </Button>
        }
      />

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Members</CardTitle>
            <CardDescription>Admins manage servers and the team; members use the tools and manage their own keys.</CardDescription>
          </CardHeader>
          <CardContent>
            {users.isPending && <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>}
            {users.isError && <QueryError error={users.error} onRetry={() => void users.refetch()} />}
            {users.data && users.data.length === 0 && <EmptyState icon={Users} title="No members" description="Invite the first person to your team." />}
            {users.data && users.data.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>Email</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Active keys</TableHead>
                    <TableHead>Joined</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.data.map((u: TeamUser) => {
                    const isOpen = expanded === u.id;
                    const isMe = u.id === me.id;
                    return (
                      <Fragment key={u.id}>
                        <TableRow>
                          <TableCell>
                            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`${isOpen ? "Hide" : "Show"} keys of ${u.email}`} aria-expanded={isOpen} onClick={() => setExpanded(isOpen ? null : u.id)}>
                              {isOpen ? <ChevronDown /> : <ChevronRight />}
                            </Button>
                          </TableCell>
                          <TableCell className="font-medium">
                            {u.email} {isMe && <Badge variant="neutral" className="ml-1">you</Badge>}
                          </TableCell>
                          <TableCell>
                            <NativeSelect
                              className="h-8 w-32"
                              value={u.role}
                              disabled={isMe || changeRole.isPending}
                              title={isMe ? "You cannot change your own role" : undefined}
                              aria-label={`Role of ${u.email}`}
                              onChange={(e) => changeRole.mutate({ id: u.id, role: e.target.value as Role })}
                            >
                              <option value="member">member</option>
                              <option value="admin">admin</option>
                            </NativeSelect>
                          </TableCell>
                          <TableCell className="text-muted-foreground">{u.activeKeys}</TableCell>
                          <TableCell className="text-muted-foreground" title={formatDateTime(u.createdAt)}>{relativeTime(u.createdAt)}</TableCell>
                        </TableRow>
                        {isOpen && (
                          <TableRow className="hover:bg-transparent">
                            <TableCell />
                            <TableCell colSpan={4} className="pb-6">
                              <UserKeys userId={u.id} email={u.email} />
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Invitations</CardTitle>
            <CardDescription>Links are shown once, when you create them, and each works a single time.</CardDescription>
          </CardHeader>
          <CardContent>
            {invites.isPending && <Skeleton className="h-10 w-full" />}
            {invites.isError && <QueryError error={invites.error} onRetry={() => void invites.refetch()} />}
            {invites.data && invites.data.length === 0 && <EmptyState icon={Mail} title="No invitations yet" description="Invite someone and they will show up here." />}
            {invites.data && invites.data.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Expires</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invites.data.map((i: InviteRow) => (
                    <TableRow key={i.id}>
                      <TableCell className="font-medium">{i.email}</TableCell>
                      <TableCell className="text-muted-foreground">{i.role}</TableCell>
                      <TableCell>
                        <Badge variant={i.status === "accepted" ? "success" : i.status === "pending" ? "default" : "neutral"}>{i.status}</Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{i.status === "pending" ? formatDateTime(i.expiresAt) : "-"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <InviteDialog open={inviteOpen} onClose={() => setInviteOpen(false)} />
    </>
  );
}

function UserKeys({ userId, email }: { userId: string; email: string }) {
  const keys = useUserKeys(userId, true);
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Keys of {email}</p>
      <KeyTable keys={keys.data} isPending={keys.isPending} error={keys.error} onRetry={() => void keys.refetch()} emptyText="This person has not created any keys." />
    </div>
  );
}

function InviteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>{open && <InviteForm onClose={onClose} />}</DialogContent>
    </Dialog>
  );
}

function InviteForm({ onClose }: { onClose: () => void }) {
  const create = useCreateInvite();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const result = create.data;

  function submit(event: FormEvent) {
    event.preventDefault();
    create.mutate({ email: email.trim(), role });
  }

  // Step 2: the link, shown once. It exists only in this mutation's result and disappears with the dialog.
  if (result) {
    return (
      <div className="grid gap-5">
        <DialogHeader>
          <DialogTitle>Invitation ready</DialogTitle>
          <DialogDescription>
            Send this link to <span className="font-medium text-foreground">{result.invite.email}</span> ({result.invite.role}). It works once and expires {formatDateTime(result.invite.expiresAt)}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <code className="block break-all rounded-md border bg-muted/60 p-3 font-mono text-xs">{result.url}</code>
          <p className="text-xs text-muted-foreground">You will not be able to see this link again. If it gets lost, invite the person again.</p>
        </div>
        <DialogFooter>
          <CopyButton value={result.url} label="Copy link" size="default" />
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-5">
      <DialogHeader>
        <DialogTitle>Invite a member</DialogTitle>
        <DialogDescription>They get a one-time link to choose their password.</DialogDescription>
      </DialogHeader>
      <div className="space-y-2">
        <Label htmlFor="invite-email">Email</Label>
        <Input id="invite-email" type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="invite-role">Role</Label>
        <NativeSelect id="invite-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          <option value="member">Member: uses tools, manages own keys</option>
          <option value="admin">Admin: also manages servers and the team</option>
        </NativeSelect>
      </div>
      {create.isError && (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {errorMessage(create.error)}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={create.isPending}>
          {create.isPending && <Loader2 className="animate-spin" />}
          Create invitation
        </Button>
      </DialogFooter>
    </form>
  );
}
