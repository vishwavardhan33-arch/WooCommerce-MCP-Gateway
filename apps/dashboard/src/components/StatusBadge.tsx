import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { elapsedSince } from "@/lib/format";
import type { ServerStatus } from "@/lib/types";

interface Props {
  status: ServerStatus;
  enabled: boolean;
  statusSince: string;
  /** The server's last error. The API only sends it to admins, so a member sees the generic text instead. */
  lastError: string | null;
}

// Green Connected / red Unreachable (tooltip: why) / grey Disabled. "Checking" is the short moment
// before the first health check has answered.
export function StatusBadge({ status, enabled, statusSince, lastError }: Props) {
  if (!enabled) return <Badge variant="neutral"><Dot className="bg-muted-foreground/60" />Disabled</Badge>;
  if (status === "up") return <Badge variant="success"><Dot className="bg-success" />Connected</Badge>;
  if (status === "unknown") return <Badge variant="neutral"><Dot className="animate-pulse bg-muted-foreground/60" />Checking</Badge>;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="destructive" className="cursor-help">
          <Dot className="bg-destructive" />
          Unreachable
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        <p className="font-medium">Unreachable for {elapsedSince(statusSince)}</p>
        <p className="mt-1 break-words text-muted-foreground">{lastError ?? "Ask an administrator for details."}</p>
      </TooltipContent>
    </Tooltip>
  );
}

const Dot = ({ className }: { className: string }) => <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${className}`} />;
