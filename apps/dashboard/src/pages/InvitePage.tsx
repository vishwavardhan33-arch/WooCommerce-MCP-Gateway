import { Loader2, Server } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/api";
import { useAcceptInvite } from "@/lib/queries";

// Where an invite link lands. The link carries a one-time token; the person only chooses a password.
export function InvitePage() {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const accept = useAcceptInvite(token);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  const tooShort = password.length > 0 && password.length < 12;
  const mismatch = confirm.length > 0 && confirm !== password;

  function submit(event: FormEvent) {
    event.preventDefault();
    accept.mutate(password, {
      onSuccess: (data) => {
        toast.success(`Account created for ${data.user.email}. You can log in now.`);
        navigate("/login", { replace: true });
      },
    });
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Server className="h-5 w-5" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">MCP Gateway</h1>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Join your team</CardTitle>
            <CardDescription>Choose a password to finish creating your account.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="new-password">Password</Label>
                <Input id="new-password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
                <p className={tooShort ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>At least 12 characters.</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirm-password">Repeat password</Label>
                <Input id="confirm-password" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
                {mismatch && <p className="text-xs text-destructive">The passwords do not match.</p>}
              </div>
              {accept.isError && (
                <p role="alert" className="text-sm text-destructive">
                  {errorMessage(accept.error)}
                </p>
              )}
              <Button type="submit" className="w-full" disabled={accept.isPending || tooShort || mismatch || password === ""}>
                {accept.isPending && <Loader2 className="animate-spin" />}
                Create account
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                Already have an account? <Link to="/login" className="text-primary hover:underline">Log in</Link>
              </p>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
