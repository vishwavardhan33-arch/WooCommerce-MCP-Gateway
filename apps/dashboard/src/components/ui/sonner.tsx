import { Toaster as Sonner } from "sonner";
import { useTheme } from "@/lib/theme";

// Toasts follow the app's theme and use our card colors, so they look native in light and dark.
export function Toaster() {
  const { resolved } = useTheme();
  return (
    <Sonner
      theme={resolved}
      position="bottom-right"
      closeButton
      toastOptions={{
        classNames: {
          toast: "group border border-border bg-card text-card-foreground shadow-lg",
          description: "text-muted-foreground",
        },
      }}
    />
  );
}
