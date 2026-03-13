import type {
  ProjectListItem,
  SessionSummary,
  SessionDetail,
  CreateSessionRequest,
  CreateSessionResponse,
  DeleteSessionResponse,
  TerminalInfo,
  CreateTerminalResponse,
  HubInfoResponse,
  NodeInfo,
} from "@qoder-anywhere/shared";

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res
      .json()
      .catch(() => ({ error: { message: res.statusText } }));
    throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function fetchProjects(): Promise<ProjectListItem[]> {
  return fetchJSON<ProjectListItem[]>("/api/projects");
}

export function fetchSessions(cwd: string): Promise<SessionSummary[]> {
  return fetchJSON<SessionSummary[]>(
    `/api/sessions?cwd=${encodeURIComponent(cwd)}`,
  );
}

export function fetchSessionDetail(sessionId: string): Promise<SessionDetail> {
  return fetchJSON<SessionDetail>(`/api/sessions/${sessionId}`);
}

export function createSession(
  cwd: string,
  req: CreateSessionRequest,
): Promise<CreateSessionResponse> {
  return fetchJSON<CreateSessionResponse>(
    `/api/sessions?cwd=${encodeURIComponent(cwd)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    },
  );
}

export function deleteSession(
  sessionId: string,
): Promise<DeleteSessionResponse> {
  return fetchJSON<DeleteSessionResponse>(`/api/sessions/${sessionId}`, {
    method: "DELETE",
  });
}

// ── Terminal API ──

export function createTerminal(cwd: string): Promise<CreateTerminalResponse> {
  return fetchJSON<CreateTerminalResponse>("/api/terminals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd }),
  });
}

export function fetchTerminals(cwd: string): Promise<TerminalInfo[]> {
  return fetchJSON<TerminalInfo[]>(
    `/api/terminals?cwd=${encodeURIComponent(cwd)}`,
  );
}

export function deleteTerminal(
  id: string,
): Promise<{ id: string; killed: boolean }> {
  return fetchJSON<{ id: string; killed: boolean }>(`/api/terminals/${id}`, {
    method: "DELETE",
  });
}

// ── Auth API ──

/** Fetch a short-lived WS auth token. Returns empty string if auth disabled. */
export async function fetchWsToken(): Promise<string> {
  try {
    const { token } = await fetchJSON<{ token: string }>("/api/auth/ws-token");
    return token;
  } catch {
    return "";
  }
}

/** Build a WebSocket URL with optional auth token. */
export function buildWsUrl(path: string, token?: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(path, `${protocol}//${window.location.host}`);
  if (token) {
    url.searchParams.set("token", token);
  }
  return url.toString();
}

// ── Hub API ──

export function fetchHubInfo(): Promise<HubInfoResponse> {
  return fetchJSON<HubInfoResponse>("/api/hub/info");
}

export function fetchNodes(): Promise<NodeInfo[]> {
  return fetchJSON<NodeInfo[]>("/api/nodes");
}

/** Fetch projects for a specific node (proxied through hub). */
export function fetchNodeProjects(nodeId: string): Promise<ProjectListItem[]> {
  return fetchJSON<ProjectListItem[]>(`/api/node/${nodeId}/projects`);
}

/** Fetch sessions for a specific node + cwd (proxied through hub). */
export function fetchNodeSessions(
  nodeId: string,
  cwd: string,
): Promise<SessionSummary[]> {
  return fetchJSON<SessionSummary[]>(
    `/api/node/${nodeId}/sessions?cwd=${encodeURIComponent(cwd)}`,
  );
}

/** Fetch session detail via hub proxy. */
export function fetchNodeSessionDetail(
  nodeId: string,
  sessionId: string,
): Promise<SessionDetail> {
  return fetchJSON<SessionDetail>(`/api/node/${nodeId}/sessions/${sessionId}`);
}

/** Create session via hub proxy. */
export function createNodeSession(
  nodeId: string,
  cwd: string,
  req: CreateSessionRequest,
): Promise<CreateSessionResponse> {
  return fetchJSON<CreateSessionResponse>(
    `/api/node/${nodeId}/sessions?cwd=${encodeURIComponent(cwd)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    },
  );
}

/** Delete session via hub proxy. */
export function deleteNodeSession(
  nodeId: string,
  sessionId: string,
): Promise<DeleteSessionResponse> {
  return fetchJSON<DeleteSessionResponse>(
    `/api/node/${nodeId}/sessions/${sessionId}`,
    { method: "DELETE" },
  );
}

/** Create terminal via hub proxy. */
export function createNodeTerminal(
  nodeId: string,
  cwd: string,
): Promise<CreateTerminalResponse> {
  return fetchJSON<CreateTerminalResponse>(`/api/node/${nodeId}/terminals`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd }),
  });
}

/** Fetch terminals via hub proxy. */
export function fetchNodeTerminals(
  nodeId: string,
  cwd: string,
): Promise<TerminalInfo[]> {
  return fetchJSON<TerminalInfo[]>(
    `/api/node/${nodeId}/terminals?cwd=${encodeURIComponent(cwd)}`,
  );
}

/** Delete terminal via hub proxy. */
export function deleteNodeTerminal(
  nodeId: string,
  id: string,
): Promise<{ id: string; killed: boolean }> {
  return fetchJSON<{ id: string; killed: boolean }>(
    `/api/node/${nodeId}/terminals/${id}`,
    { method: "DELETE" },
  );
}
