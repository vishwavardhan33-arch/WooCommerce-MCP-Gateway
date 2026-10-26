import { cn } from "@/lib/utils";
import { CopyButton } from "./CopyButton";

export function CodeBlock({ code, className }: { code: string; className?: string }) {
  return (
    <div className={cn("relative rounded-md border bg-muted/60", className)}>
      <pre className="overflow-x-auto p-4 pr-24 font-mono text-xs leading-relaxed">{code}</pre>
      <div className="absolute right-2 top-2">
        <CopyButton value={code} />
      </div>
    </div>
  );
}
