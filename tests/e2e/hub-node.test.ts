import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import {
  startHub,
  startNode,
  type HubHandle,
  type NodeHandle,
} from "./helpers/hub-lifecycle.js";
import { WSClient } from "./helpers/ws-client.js";

const THIS_CWD = process.cwd();
const TEST_CWD = "/Users/jiamingmao/repos/test-qoder-anywhere";

let hub: HubHandle;
let node: NodeHandle;
let nodeId: string;
let cookie: string;

// ── Helpers ──

/** Authenticated fetch against the hub. */
function hubFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${hub.baseUrl}${path}`, {
    ...init,
    headers: { ...init?.headers, Cookie: cookie },
  });
}

async function hubJSON<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await hubFetch(path, init);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

/** Build an authenticated WS URL (via ?token= query param). */
async function getWsToken(): Promise<string> {
  const res = await hubFetch("/api/auth/ws-token");
  if (!res.ok) return "";
  const { token } = (await res.json()) as { token: string };
  return token;
}

// ── Setup / teardown ──

beforeAll(async () => {
  // 1. Start hub
  hub = await startHub();

  // 2. Authenticate with hub (get session cookie)
  const authRes = await fetch(`${hub.baseUrl}/api/auth/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: hub.accessCode }),
  });
  expect(authRes.ok).toBe(true);
  const setCookie = authRes.headers.getSetCookie?.() ?? [];
  cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  expect(cookie).toBeTruthy();

  // 3. Start node and connect to hub
  node = await startNode(hub.baseUrl, hub.accessCode);
});

afterAll(async () => {
  await node?.stop();
  await hub?.stop();
});

// ── Tests ──

describe("Hub-Node E2E", () => {
  // ── Hub info & node list ──

  it("GET /api/hub/info — reports hub mode", async () => {
    // Public endpoint — no cookie needed
    const res = await fetch(`${hub.baseUrl}/api/hub/info`);
    expect(res.ok).toBe(true);

    const info = await res.json();
    expect(info).toEqual({
      isHub: true,
      nodeCount: 1,
    });
  });

  it("GET /api/nodes — lists the connected node", async () => {
    const nodes =
      await hubJSON<{ nodeId: string; name: string; connectedAt: number }[]>(
        "/api/nodes",
      );

    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toHaveProperty("nodeId");
    expect(nodes[0]).toHaveProperty("name");
    expect(nodes[0]).toHaveProperty("connectedAt");
    expect(typeof nodes[0].nodeId).toBe("string");
    expect(typeof nodes[0].connectedAt).toBe("number");

    // Save nodeId for later tests
    nodeId = nodes[0].nodeId;
  });

  // ── REST proxy: read-only ──

  it("GET /api/node/:id/projects — proxies project list from node", async () => {
    expect(nodeId).toBeDefined();

    const projects = await hubJSON<{ cwd: string; sessionCount: number }[]>(
      `/api/node/${nodeId}/projects`,
    );

    expect(Array.isArray(projects)).toBe(true);
    // The node has real sessions, so there should be at least one project
    if (projects.length > 0) {
      expect(projects[0]).toHaveProperty("cwd");
      expect(projects[0]).toHaveProperty("sessionCount");
      expect(projects[0]).toHaveProperty("lastModified");
    }
  });

  it("GET /api/node/:id/sessions?cwd=... — proxies session list from node", async () => {
    expect(nodeId).toBeDefined();

    const cwd = encodeURIComponent(THIS_CWD);
    const sessions = await hubJSON<{ sessionId: string; state: string }[]>(
      `/api/node/${nodeId}/sessions?cwd=${cwd}`,
    );

    expect(Array.isArray(sessions)).toBe(true);
  });

  it("GET /api/node/invalid_id/projects — returns 404", async () => {
    const res = await hubFetch("/api/node/invalid_id/projects");
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error.code).toBe("NODE_NOT_FOUND");
  });

  // ── REST proxy: create / read / delete session ──

  let createdSessionId: string;

  it("POST /api/node/:id/sessions — creates a session on the node", async () => {
    expect(nodeId).toBeDefined();

    const cwd = encodeURIComponent(TEST_CWD);
    const body = await hubJSON<{ sessionId: string }>(
      `/api/node/${nodeId}/sessions?cwd=${cwd}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message:
            "Say hello briefly. Do not use any tools, just respond with text.",
          maxTurns: 1,
        }),
      },
    );

    expect(body).toHaveProperty("sessionId");
    expect(typeof body.sessionId).toBe("string");
    createdSessionId = body.sessionId;
  });

  // ── WS proxy: session streaming through hub ──

  it("WS /ws/node/:id/sessions/:session_id — receives streaming result via hub", async () => {
    expect(createdSessionId).toBeDefined();

    const token = await getWsToken();
    const wsUrl = `${hub.wsUrl}/ws/node/${nodeId}/sessions/${createdSessionId}${token ? `?token=${token}` : ""}`;
    const ws = await WSClient.connect(wsUrl);

    try {
      const result = await ws.waitForResult();
      expect(result.category).toBe("sdk");
      expect(result.message.type).toBe("result");
    } finally {
      ws.close();
    }
  });

  it("WS — sends follow-up message and receives result via hub", async () => {
    expect(createdSessionId).toBeDefined();

    // Wait for session to go idle
    await new Promise((r) => setTimeout(r, 2000));

    const token = await getWsToken();
    const wsUrl = `${hub.wsUrl}/ws/node/${nodeId}/sessions/${createdSessionId}${token ? `?token=${token}` : ""}`;
    const ws = await WSClient.connect(wsUrl);

    try {
      ws.sendMessage("Now say goodbye. Do not use any tools.");
      const result = await ws.waitForResult();
      expect(result.category).toBe("sdk");
      expect(result.message.type).toBe("result");
    } finally {
      ws.close();
    }
  });

  // ── WS proxy: hub-level sync ──

  it("WS /ws/sync — receives hub-level sync events", async () => {
    const token = await getWsToken();
    const wsUrl = `${hub.wsUrl}/ws/sync${token ? `?token=${token}` : ""}`;

    const messages: unknown[] = [];
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const conn = new WebSocket(wsUrl);
      conn.on("open", () => resolve(conn));
      conn.on("error", reject);
    });

    // Collect messages for a short window
    ws.on("message", (raw) => {
      messages.push(JSON.parse(raw.toString()));
    });

    // Wait for the initial snapshot (node_connected event)
    await new Promise((r) => setTimeout(r, 1000));
    ws.close();

    // Should have received at least one node_connected snapshot
    expect(messages.length).toBeGreaterThanOrEqual(1);
    const nodeConnected = messages.find(
      (m: unknown) => (m as { event: string }).event === "node_connected",
    );
    expect(nodeConnected).toBeDefined();
    expect((nodeConnected as { data: { nodeId: string } }).data.nodeId).toBe(
      nodeId,
    );
  });

  // ── REST proxy: terminal CRUD through hub ──

  let createdTerminalId: string;

  it("POST /api/node/:id/terminals — creates a terminal on the node via hub", async () => {
    expect(nodeId).toBeDefined();

    const body = await hubJSON<{ id: string }>(
      `/api/node/${nodeId}/terminals`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: TEST_CWD }),
      },
    );

    expect(body).toHaveProperty("id");
    expect(typeof body.id).toBe("string");
    createdTerminalId = body.id;
  });

  it("GET /api/node/:id/terminals?cwd=... — lists terminals on the node via hub", async () => {
    expect(nodeId).toBeDefined();
    expect(createdTerminalId).toBeDefined();

    const cwd = encodeURIComponent(TEST_CWD);
    const terminals = await hubJSON<
      { id: string; cwd: string; pid: number; createdAt: string }[]
    >(`/api/node/${nodeId}/terminals?cwd=${cwd}`);

    expect(Array.isArray(terminals)).toBe(true);
    expect(terminals.length).toBeGreaterThanOrEqual(1);

    const match = terminals.find((t) => t.id === createdTerminalId);
    expect(match).toBeDefined();
    expect(match!.cwd).toBe(TEST_CWD);
    expect(typeof match!.pid).toBe("number");
  });

  it("WS /ws/node/:id/terminal/:terminal_id — proxies terminal I/O through hub", async () => {
    expect(createdTerminalId).toBeDefined();

    const token = await getWsToken();
    const wsUrl = `${hub.wsUrl}/ws/node/${nodeId}/terminal/${createdTerminalId}${token ? `?token=${token}` : ""}`;

    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const conn = new WebSocket(wsUrl);
      conn.on("open", () => resolve(conn));
      conn.on("error", reject);
    });

    const messages: { type: string; data?: string; exitCode?: number }[] = [];

    try {
      // Collect output messages
      ws.on("message", (raw) => {
        try {
          messages.push(JSON.parse(raw.toString()));
        } catch {
          // ignore non-JSON
        }
      });

      // Wait for the shell to initialize
      await new Promise((r) => setTimeout(r, 500));

      // Send a resize event (should not error)
      ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));

      // Send a command through the terminal
      const marker = `__QODER_TEST_${Date.now()}__`;
      ws.send(JSON.stringify({ type: "input", data: `echo ${marker}\n` }));

      // Wait for the echoed marker to appear in output
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const allOutput = messages
          .filter((m) => m.type === "output")
          .map((m) => m.data)
          .join("");
        if (allOutput.includes(marker)) break;
        await new Promise((r) => setTimeout(r, 200));
      }

      const allOutput = messages
        .filter((m) => m.type === "output")
        .map((m) => m.data)
        .join("");
      expect(allOutput).toContain(marker);
    } finally {
      ws.close();
    }
  });

  it("DELETE /api/node/:id/terminals/:terminal_id — deletes terminal via hub", async () => {
    expect(createdTerminalId).toBeDefined();

    const body = await hubJSON<{ id: string; killed: boolean }>(
      `/api/node/${nodeId}/terminals/${createdTerminalId}`,
      { method: "DELETE" },
    );

    expect(body).toHaveProperty("id", createdTerminalId);
    expect(body).toHaveProperty("killed", true);
  });

  it("GET /api/node/:id/terminals?cwd=... — terminal is gone after delete", async () => {
    expect(nodeId).toBeDefined();

    const cwd = encodeURIComponent(TEST_CWD);
    const terminals = await hubJSON<{ id: string }[]>(
      `/api/node/${nodeId}/terminals?cwd=${cwd}`,
    );

    const match = terminals.find((t) => t.id === createdTerminalId);
    expect(match).toBeUndefined();
  });

  // ── Cleanup ──

  it("DELETE /api/node/:id/sessions/:session_id — stops session via hub", async () => {
    expect(createdSessionId).toBeDefined();

    const body = await hubJSON<{ sessionId: string; stopped: boolean }>(
      `/api/node/${nodeId}/sessions/${createdSessionId}`,
      { method: "DELETE" },
    );

    expect(body).toHaveProperty("sessionId", createdSessionId);
    expect(body).toHaveProperty("stopped");
  });
});
