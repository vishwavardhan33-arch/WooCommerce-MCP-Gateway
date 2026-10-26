import { Loader2, TriangleAlert } from "lucide-react";
import { useState, type FormEvent } from "react";
import { CodeBlock } from "@/components/CodeBlock";
import { CopyButton } from "@/components/CopyButton";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { claudeCodeSnippet, cursorSnippet, inspectorCommand, inspectorFields, KEY_PLACEHOLDER } from "@/lib/snippets";
import { useCreateKey, useMyKeys } from "@/lib/queries";
import { KeyTable } from "./KeyTable";

// "My key": create a personal API key and get the exact commands to connect a client with it.
export function ConnectPage() {
  const keys = useMyKeys();
  const create = useCreateKey();
  const [name, setName] = useState("");
  // The new key lives ONLY in this component's state: it is shown once, used to fill the snippets,
  // and gone when the person clicks "I've saved it" or leaves the page. It is never stored or re-fetched.
  const [fresh, setFresh] = useState<{ name: string; key: string } | null>(null);

  const gatewayUrl = `${window.location.origin}/mcp`;
  const key = fresh?.key ?? KEY_PLACEHOLDER;

  function submit(event: FormEvent) {
    event.preventDefault();
    create.mutate(name.trim(), {
      onSuccess: (data) => {
        setFresh({ name: data.apiKey.name, key: data.key });
        setName("");
      },
    });
  }

  return (
    <>
      <PageHeader title="My key" description="Create a personal API key, then connect Claude Code, Cursor or any MCP client to every tool on this gateway with it." />

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Create a key</CardTitle>
            <CardDescription>Give it a name that tells you where it is used, so you know what to revoke later.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex-1 space-y-2">
                <Label htmlFor="key-name">Name</Label>
                <Input id="key-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Claude Code on my laptop" required maxLength={100} />
              </div>
              <Button type="submit" disabled={create.isPending || name.trim() === ""}>
                {create.isPending && <Loader2 className="animate-spin" />}
                Generate key
              </Button>
            </form>

            {fresh && (
              <div role="status" className="space-y-3 rounded-lg border border-warning/40 bg-warning/10 p-4">
                <div className="flex items-start gap-2 text-sm">
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                  <p>
                    <span className="font-medium">Copy your new key now.</span> This is the only time it is shown. If you lose it, revoke it and create another.
                  </p>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <code className="flex-1 break-all rounded-md border bg-card px-3 py-2 font-mono text-xs" aria-label={`New key ${fresh.name}`}>
                    {fresh.key}
                  </code>
                  <CopyButton value={fresh.key} label="Copy key" />
                </div>
                <Button variant="outline" size="sm" onClick={() => setFresh(null)}>
                  I have saved it
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
            <div className="space-y-1.5">
              <CardTitle>Connect a client</CardTitle>
              <CardDescription>
                {fresh ? "These commands already contain your new key." : <>Replace <code className="font-mono text-xs">{KEY_PLACEHOLDER}</code> with a key, or generate one above to fill it in for you.</>}
              </CardDescription>
            </div>
            {fresh && <Badge variant="warning">Contains your key</Badge>}
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="claude">
              <TabsList>
                <TabsTrigger value="claude">Claude Code</TabsTrigger>
                <TabsTrigger value="cursor">Cursor</TabsTrigger>
                <TabsTrigger value="inspector">MCP Inspector</TabsTrigger>
              </TabsList>
              <TabsContent value="claude" className="space-y-3">
                <p className="text-sm text-muted-foreground">Run this once in a terminal. Claude Code then lists all the gateway's tools.</p>
                <CodeBlock code={claudeCodeSnippet(gatewayUrl, key)} />
              </TabsContent>
              <TabsContent value="cursor" className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Put this in <code className="font-mono text-xs">~/.cursor/mcp.json</code> (all projects) or <code className="font-mono text-xs">.cursor/mcp.json</code> (one project), then restart Cursor.
                </p>
                <CodeBlock code={cursorSnippet(gatewayUrl, key)} />
              </TabsContent>
              <TabsContent value="inspector" className="space-y-3">
                <p className="text-sm text-muted-foreground">Start the inspector, then fill in its connection panel with these values.</p>
                <CodeBlock code={inspectorCommand} />
                <dl className="divide-y rounded-md border text-sm">
                  {inspectorFields(gatewayUrl, key).map((f) => (
                    <div key={f.label} className="flex flex-col gap-1 p-3 sm:flex-row sm:items-center sm:justify-between">
                      <dt className="text-muted-foreground">{f.label}</dt>
                      <dd className="flex items-center gap-2">
                        <code className="break-all font-mono text-xs">{f.value}</code>
                        <CopyButton value={f.value} />
                      </dd>
                    </div>
                  ))}
                </dl>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Your keys</CardTitle>
            <CardDescription>Only the beginning of each key is shown. Revoking one takes effect on its next request.</CardDescription>
          </CardHeader>
          <CardContent>
            <KeyTable keys={keys.data} isPending={keys.isPending} error={keys.error} onRetry={() => void keys.refetch()} emptyText="You have not created a key yet. Generate one above." />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
