import { KeyRound, LogOut, MessageSquare, Moon, ScrollText, Server, Sun, Users, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useLogout } from "@/lib/queries";
import { useTheme } from "@/lib/theme";
import type { Role, User } from "@/lib/types";
import { cn } from "@/lib/utils";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Omitted = everyone; "admin" = administrators only. */
  role?: Role;
}

// Role-aware navigation: members never see the Team link. (The routes and the API enforce it as well.)
const NAV: NavItem[] = [
  { to: "/servers", label: "Servers", icon: Server },
  { to: "/connect", label: "My key", icon: KeyRound },
  { to: "/audit", label: "Audit", icon: ScrollText },
  { to: "/chat", label: "Chat", icon: MessageSquare },
  { to: "/team", label: "Team", icon: Users, role: "admin" },
];

export function Layout({ user, children }: { user: User; children: ReactNode }) {
  const { resolved, setTheme } = useTheme();
  const logout = useLogout();
  const items = NAV.filter((item) => !item.role || item.role === user.role);

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
      isActive ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground",
    );

  return (
    <div className="min-h-screen md:flex">
      <aside className="hidden w-60 shrink-0 flex-col border-r bg-card md:flex">
        <div className="flex h-16 items-center gap-2.5 px-5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Server className="h-4 w-4" />
          </div>
          <span className="font-semibold tracking-tight">MCP Gateway</span>
        </div>
        <nav className="flex-1 space-y-1 px-3 py-2">
          {items.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} className={linkClass}>
              <Icon className="h-4 w-4" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="space-y-3 border-t p-4">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium" title={user.email}>{user.email}</p>
            <Badge variant={user.role === "admin" ? "default" : "neutral"} className="mt-1">{user.role}</Badge>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="icon" aria-label={resolved === "dark" ? "Switch to light mode" : "Switch to dark mode"} onClick={() => setTheme(resolved === "dark" ? "light" : "dark")}>
              {resolved === "dark" ? <Sun /> : <Moon />}
            </Button>
            <Button variant="outline" className="flex-1" onClick={() => logout.mutate()}>
              <LogOut /> Log out
            </Button>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Small screens: the sidebar becomes a top bar with a scrollable row of links. */}
        <header className="border-b bg-card md:hidden">
          <div className="flex h-14 items-center justify-between px-4">
            <span className="font-semibold tracking-tight">MCP Gateway</span>
            <div className="flex gap-1">
              <Button variant="ghost" size="icon" aria-label="Toggle theme" onClick={() => setTheme(resolved === "dark" ? "light" : "dark")}>
                {resolved === "dark" ? <Sun /> : <Moon />}
              </Button>
              <Button variant="ghost" size="icon" aria-label="Log out" onClick={() => logout.mutate()}>
                <LogOut />
              </Button>
            </div>
          </div>
          <nav className="flex gap-1 overflow-x-auto px-3 pb-2">
            {items.map(({ to, label, icon: Icon }) => (
              <NavLink key={to} to={to} className={(s) => cn(linkClass(s), "shrink-0")}>
                <Icon className="h-4 w-4" />
                {label}
              </NavLink>
            ))}
          </nav>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-8 sm:py-10">{children}</main>
      </div>
    </div>
  );
}
