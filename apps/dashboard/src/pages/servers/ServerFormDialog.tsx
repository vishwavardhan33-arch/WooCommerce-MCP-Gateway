import { Loader2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/lib/api";
import { useSaveServer } from "@/lib/queries";
import type { AuthType, Server, ServerInput } from "@/lib/types";

interface Props {
  /** A server to edit, "new" to add one, or null when closed. */
  target: Server | "new" | null;
  onClose: () => void;
}

export function ServerFormDialog({ target, onClose }: Props) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {/* The key makes the form start fresh for each target instead of keeping the previous one's text. */}
        {target !== null && <ServerForm key={target === "new" ? "new" : target.id} target={target} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function ServerForm({ target, onClose }: { target: Server | "new"; onClose: () => void }) {
  const editing = target !== "new" ? target : null;
  const save = useSaveServer();
  const [slug, setSlug] = useState(editing?.slug ?? "");
  const [url, setUrl] = useState(editing?.url ?? "");
  const [authType, setAuthType] = useState<AuthType>(editing?.authType ?? "none");
  const [credential, setCredential] = useState(""); // never pre-filled: the API never returns it
  const [timeoutSeconds, setTimeoutSeconds] = useState(String((editing?.timeoutMs ?? 15_000) / 1000));
  const [enabled, setEnabled] = useState(editing?.enabled ?? true);

  function submit(event: FormEvent) {
    event.preventDefault();
    const input: Partial<ServerInput> = {
      url: url.trim(),
      authType,
      timeoutMs: Math.round(Number(timeoutSeconds) * 1000),
      enabled,
    };
    if (authType === "bearer" && credential) input.credential = credential;
    if (!editing) input.slug = slug.trim();
    save.mutate({ id: editing?.id, input }, { onSuccess: onClose });
  }

  // A saved bearer token can be kept by leaving the field empty. In every other case a bearer
  // server needs a token typed in (new server, or switching an existing one to bearer).
  const hasSavedBearer = !!editing && editing.authType === "bearer" && editing.hasCredential;
  const needsCredential = authType === "bearer" && !hasSavedBearer;

  return (
    <form onSubmit={submit} className="grid gap-5">
      <DialogHeader>
        <DialogTitle>{editing ? `Edit ${editing.slug}` : "Add a server"}</DialogTitle>
        <DialogDescription>
          {editing ? "Changes apply within a few seconds." : "The gateway connects to this MCP server and republishes its tools."}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-2">
        <Label htmlFor="slug">Name (slug)</Label>
        <Input id="slug" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} disabled={!!editing} required maxLength={32} pattern="[a-z][a-z0-9]*(-[a-z0-9]+)*" placeholder="shop" className="font-mono" />
        <p className="text-xs text-muted-foreground">
          {editing
            ? "Cannot be changed: it is the prefix of every tool name (shop__list_products)."
            : "Starts with a letter; lower-case letters, digits and hyphens. It becomes the prefix of every tool name, e.g. shop__list_products."}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="url">URL</Label>
        <Input id="url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} required placeholder="http://platform-apps-mcp-fx/mcp" />
        <p className="text-xs text-muted-foreground">Cluster-internal hosts must be on the gateway's allowlist.</p>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="auth">Authentication</Label>
          <NativeSelect id="auth" value={authType} onChange={(e) => setAuthType(e.target.value as AuthType)}>
            <option value="none">None</option>
            <option value="bearer">Bearer token</option>
          </NativeSelect>
        </div>
        <div className="space-y-2">
          <Label htmlFor="timeout">Timeout (seconds)</Label>
          <Input id="timeout" type="number" min={1} max={120} step={1} value={timeoutSeconds} onChange={(e) => setTimeoutSeconds(e.target.value)} required />
        </div>
      </div>

      {authType === "bearer" && (
        <div className="space-y-2">
          <Label htmlFor="credential">Bearer token</Label>
          <Input
            id="credential"
            type="password"
            autoComplete="off"
            value={credential}
            onChange={(e) => setCredential(e.target.value)}
            required={needsCredential}
            placeholder={hasSavedBearer ? "•••••••• (saved)" : ""}
          />
          <p className="text-xs text-muted-foreground">
            {hasSavedBearer
              ? "A token is saved. Leave this empty to keep it, or type a new one to replace it. Saved tokens are never shown."
              : "Stored encrypted. It cannot be viewed again after saving."}
          </p>
        </div>
      )}

      <label className="flex items-center justify-between rounded-md border p-3 text-sm">
        <span>
          <span className="font-medium">Enabled</span>
          <span className="block text-xs text-muted-foreground">Disabled servers are not contacted and their tools are hidden.</span>
        </span>
        <Switch checked={enabled} onCheckedChange={setEnabled} />
      </label>

      {save.isError && (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {errorMessage(save.error)}
        </p>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending && <Loader2 className="animate-spin" />}
          {editing ? "Save changes" : "Add server"}
        </Button>
      </DialogFooter>
    </form>
  );
}
