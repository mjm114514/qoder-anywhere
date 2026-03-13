import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startServer, type ServerHandle } from "./helpers/server-lifecycle.js";
import { WSClient } from "./helpers/ws-client.js";

const THIS_CWD = process.cwd();
const TEST_CWD = "/Users/jiamingmao/repos/test-qoder-anywhere";

let server: ServerHandle;
let createdSessionId: string;

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server?.stop();
});

describe("E2E: REST + WebSocket", () => {
  it("GET /api/projects — returns an array of projects", async () => {
    const res = await fetch(`${server.baseUrl}/api/projects`);
    expect(res.ok).toBe(true);

    const projects = await res.json();
    expect(Array.isArray(projects)).toBe(true);

    if (projects.length > 0) {
      expect(projects[0]).toHaveProperty("cwd");
      expect(projects[0]).toHaveProperty("sessionCount");
      expect(projects[0]).toHaveProperty("lastModified");
    }
  });

  it("GET /api/sessions?cwd=... — lists sessions for this cwd", async () => {
    const cwd = encodeURIComponent(THIS_CWD);
    const res = await fetch(
      `${server.baseUrl}/api/sessions?cwd=${cwd}&limit=3`,
    );
    expect(res.ok).toBe(true);

    const sessions = await res.json();
    expect(Array.isArray(sessions)).toBe(true);
  });

  it("GET /api/sessions/:session_id — returns session detail", async () => {
    // Grab a session ID from the list
    const cwd = encodeURIComponent(THIS_CWD);
    const res = await fetch(
      `${server.baseUrl}/api/sessions?cwd=${cwd}&limit=1`,
    );
    const sessions = await res.json();

    if (sessions.length === 0) {
      // No sessions to test — skip gracefully
      return;
    }

    const sessionId = sessions[0].sessionId;
    const detail = await fetch(
      `${server.baseUrl}/api/sessions/${sessionId}?limit=3`,
    );
    expect(detail.ok).toBe(true);

    const data = await detail.json();
    expect(data).toHaveProperty("sessionId", sessionId);
    expect(data).toHaveProperty("summary");
    expect(data).toHaveProperty("state");
    expect(data).toHaveProperty("messages");
    expect(Array.isArray(data.messages)).toBe(true);
  });

  it("POST /api/sessions?cwd=... — creates a new session", async () => {
    const cwd = encodeURIComponent(TEST_CWD);
    const res = await fetch(`${server.baseUrl}/api/sessions?cwd=${cwd}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message:
          "Say hello and tell me what directory you are in. Do not use any tools, just respond with text.",
        maxTurns: 1,
      }),
    });
    expect(res.ok).toBe(true);

    const body = await res.json();
    expect(body).toHaveProperty("sessionId");
    expect(typeof body.sessionId).toBe("string");

    createdSessionId = body.sessionId;
  });

  it("WebSocket — connects and receives streaming result", async () => {
    expect(createdSessionId).toBeDefined();

    const ws = await WSClient.connect(
      `${server.wsUrl}/ws/sessions/${createdSessionId}`,
    );

    try {
      // SDK result message arrives as { category: "sdk", message: { type: "result", ... } }
      const result = await ws.waitForResult();
      expect(result.category).toBe("sdk");
      expect(result.message.type).toBe("result");
    } finally {
      ws.close();
    }
  });

  it("WebSocket — sends follow-up message and receives result", async () => {
    expect(createdSessionId).toBeDefined();

    // Wait for session to go idle
    await new Promise((r) => setTimeout(r, 2000));

    const ws = await WSClient.connect(
      `${server.wsUrl}/ws/sessions/${createdSessionId}`,
    );

    try {
      ws.sendMessage("Now say goodbye. Do not use any tools.");
      const result = await ws.waitForResult();
      expect(result.category).toBe("sdk");
      expect(result.message.type).toBe("result");
    } finally {
      ws.close();
    }
  });

  it("PUT /api/sessions/:session_id — updates session", async () => {
    expect(createdSessionId).toBeDefined();

    const res = await fetch(
      `${server.baseUrl}/api/sessions/${createdSessionId}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Test Session", model: "sonnet" }),
      },
    );
    expect(res.ok).toBe(true);

    const body = await res.json();
    expect(body).toHaveProperty("sessionId", createdSessionId);
  });

  it("DELETE /api/sessions/:session_id — stops session", async () => {
    expect(createdSessionId).toBeDefined();

    const res = await fetch(
      `${server.baseUrl}/api/sessions/${createdSessionId}`,
      { method: "DELETE" },
    );
    expect(res.ok).toBe(true);

    const body = await res.json();
    expect(body).toHaveProperty("sessionId", createdSessionId);
    expect(body).toHaveProperty("stopped");
  });
});
