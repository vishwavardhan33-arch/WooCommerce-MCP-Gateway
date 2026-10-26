import { Navigate, Outlet, useLocation } from "react-router-dom";
import { Layout } from "@/components/Layout";
import { QueryError } from "@/components/QueryError";
import { Skeleton } from "@/components/ui/skeleton";
import { useMe } from "./queries";
import type { User } from "./types";

// Inside <RequireAuth> there is always a user; this hook says so to TypeScript instead of every page checking for null.
export function useCurrentUser(): User {
  const { data } = useMe();
  if (!data) throw new Error("useCurrentUser() used outside <RequireAuth>");
  return data;
}

// Wraps every page that needs a login. Not logged in -> the login page, remembering where you were going.
export function RequireAuth() {
  const me = useMe();
  const location = useLocation();

  if (me.isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center p-8">
        <div className="w-full max-w-sm space-y-3">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </div>
    );
  }
  if (me.isError) return <div className="p-8"><QueryError error={me.error} onRetry={() => void me.refetch()} /></div>;
  if (!me.data) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return (
    <Layout user={me.data}>
      <Outlet />
    </Layout>
  );
}

// Role-aware routing: members who type /team in the address bar land back on the servers page.
// (The gateway enforces this too; hiding the page is for a clean UI, not for security.)
export function RequireAdmin() {
  const user = useCurrentUser();
  return user.role === "admin" ? <Outlet /> : <Navigate to="/servers" replace />;
}
