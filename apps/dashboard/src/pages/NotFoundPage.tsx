import { Compass } from "lucide-react";
import { Link } from "react-router-dom";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";

export function NotFoundPage() {
  return (
    <EmptyState
      icon={Compass}
      title="Page not found"
      description="That address does not lead anywhere here."
      action={
        <Button asChild>
          <Link to="/servers">Back to servers</Link>
        </Button>
      }
    />
  );
}
