import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError, errorMessage } from "./api";
import type {
  ApiKeyRow, AuditEntry, AuditFilters, AuditSummaryRow, InviteRow, Role, Server, ServerInput, TeamUser, ToolGroup, User,
} from "./types";

// Server status is polled every 5 seconds, as the manager refreshes upstream health every 10 s.
export const STATUS_POLL_MS = 5_000;
export const AUDIT_POLL_MS = 10_000;

const fail = (err: unknown) => toast.error(errorMessage(err));

// ---------------------------------------------------------------- session

export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: async (): Promise<User | null> => {
      try {
        return (await api.get<{ user: User }>("/auth/me")).user;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null; // "not logged in" is an answer, not an error
        throw err;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { email: string; password: string }) => api.post<{ user: User }>("/auth/login", v),
    onSuccess: (data) => qc.setQueryData(["me"], data.user),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post("/auth/logout"),
    onSettled: () => {
      qc.clear(); // nothing from this session may stay in memory for the next person at this browser
      qc.setQueryData(["me"], null);
    },
  });
}

export function useAcceptInvite(token: string) {
  return useMutation({ mutationFn: (password: string) => api.post<{ user: User }>(`/invites/${encodeURIComponent(token)}/accept`, { password }) });
}

// ---------------------------------------------------------------- servers and tools

export function useServers() {
  return useQuery({
    queryKey: ["servers"],
    queryFn: async () => (await api.get<{ servers: Server[] }>("/servers")).servers,
    refetchInterval: STATUS_POLL_MS,
  });
}

export function useTools(enabled: boolean) {
  return useQuery({
    queryKey: ["tools"],
    queryFn: async () => (await api.get<{ servers: ToolGroup[] }>("/tools")).servers,
    enabled,
    refetchInterval: enabled ? STATUS_POLL_MS : false,
  });
}

// Errors are NOT toasted here: the form shows them inline, next to the field that caused them.
export function useSaveServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id?: string; input: Partial<ServerInput> }) =>
      id ? api.patch<{ server: Server }>(`/servers/${id}`, input) : api.post<{ server: Server }>("/servers", input),
    onSuccess: (_data, { id }) => {
      toast.success(id ? "Server updated" : "Server added");
      void qc.invalidateQueries({ queryKey: ["servers"] });
      void qc.invalidateQueries({ queryKey: ["tools"] });
    },
  });
}

// The switch flips immediately (optimistic) and snaps back with a toast if the server refuses.
export function useToggleServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.patch(`/servers/${id}`, { enabled }),
    onMutate: async ({ id, enabled }) => {
      await qc.cancelQueries({ queryKey: ["servers"] });
      const previous = qc.getQueryData<Server[]>(["servers"]);
      qc.setQueryData<Server[]>(["servers"], (old) => old?.map((s) => (s.id === id ? { ...s, enabled } : s)));
      return { previous };
    },
    onError: (err, _vars, ctx) => {
      qc.setQueryData(["servers"], ctx?.previous);
      fail(err);
    },
    onSuccess: (_d, { enabled }) => toast.success(enabled ? "Server enabled" : "Server disabled"),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["servers"] });
      void qc.invalidateQueries({ queryKey: ["tools"] });
    },
  });
}

export function useDeleteServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/servers/${id}`),
    onSuccess: () => {
      toast.success("Server deleted");
      void qc.invalidateQueries({ queryKey: ["servers"] });
      void qc.invalidateQueries({ queryKey: ["tools"] });
    },
    onError: fail,
  });
}

// ---------------------------------------------------------------- team

export function useUsers(enabled = true) {
  return useQuery({ queryKey: ["users"], queryFn: async () => (await api.get<{ users: TeamUser[] }>("/users")).users, enabled });
}

export function useInvites() {
  return useQuery({ queryKey: ["invites"], queryFn: async () => (await api.get<{ invites: InviteRow[] }>("/invites")).invites });
}

export function useCreateInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { email: string; role: Role }) =>
      api.post<{ invite: { id: string; email: string; role: Role; expiresAt: string }; url: string }>("/invites", v),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["invites"] }),
    gcTime: 0, // the one-time link must not linger in the query cache
  });
}

export function useChangeRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, role }: { id: string; role: Role }) => api.patch(`/users/${id}`, { role }),
    onSuccess: () => {
      toast.success("Role updated");
      void qc.invalidateQueries({ queryKey: ["users"] });
    },
    onError: fail,
  });
}

// ---------------------------------------------------------------- API keys

export function useMyKeys() {
  return useQuery({ queryKey: ["keys", "me"], queryFn: async () => (await api.get<{ apiKeys: ApiKeyRow[] }>("/api-keys")).apiKeys });
}

export function useUserKeys(userId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["keys", userId],
    queryFn: async () => (await api.get<{ apiKeys: ApiKeyRow[] }>(`/users/${userId}/api-keys`)).apiKeys,
    enabled,
  });
}

export function useCreateKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.post<{ apiKey: ApiKeyRow; key: string }>("/api-keys", { name }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["keys"] }),
    onError: fail,
    gcTime: 0, // the key is shown once: do not keep it in the mutation cache after the component has it
  });
}

export function useRevokeKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/api-keys/${id}/revoke`),
    onSuccess: () => {
      toast.success("Key revoked: it stops working immediately");
      void qc.invalidateQueries({ queryKey: ["keys"] });
      void qc.invalidateQueries({ queryKey: ["users"] });
    },
    onError: fail,
  });
}

// ---------------------------------------------------------------- audit and chat

function auditParams(filters: AuditFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value !== "" && value !== undefined) params.set(key, String(value));
  return params.toString();
}

export function useAudit(filters: AuditFilters, autoRefresh: boolean) {
  return useQuery({
    queryKey: ["audit", filters],
    queryFn: async () => (await api.get<{ entries: AuditEntry[] }>(`/audit?${auditParams(filters)}`)).entries,
    refetchInterval: autoRefresh ? AUDIT_POLL_MS : false,
    placeholderData: keepPreviousData, // while paging or filtering, keep the old rows on screen instead of flashing skeletons
  });
}

export function useAuditSummary(hours: number, autoRefresh: boolean) {
  return useQuery({
    queryKey: ["audit-summary", hours],
    queryFn: async () => (await api.get<{ servers: AuditSummaryRow[] }>(`/audit/summary?hours=${hours}`)).servers,
    refetchInterval: autoRefresh ? AUDIT_POLL_MS : false,
    placeholderData: keepPreviousData,
  });
}

export function useChatStatus() {
  return useQuery({ queryKey: ["chat-status"], queryFn: () => api.get<{ enabled: boolean; model: string | null }>("/chat/status"), staleTime: 60_000 });
}
