import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Server } from "node:http";
import type {
  WSClientMessage,
  SessionState,
  WSServerMessage,
  ControlPayload,
} from "@lgtm-anywhere/shared";
import { listSessions } from "@anthropic-ai/claude-agent-sdk";
import { SessionManager } from "../services/session-manager.js";

const WS_PATH_RE = /^\/ws\/sessions\/([^/]+)$/;
const WS_SYNC_PATH_RE = /^\/ws\/sync$/;

/** Build a control WSServerMessage. */
function controlMsg(message: ControlPayload): WSServerMessage {
  return { category: "control", message };
}

function sendError(ws: WebSocket, error: string, code: string): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(controlMsg({ type: "error", error, code })));
  }
}

function sendWS(ws: WebSocket, msg: WSServerMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

export function attachWebSocket(
  server: Server,
  sessionManager: SessionManager,
): void {
  const wss = new WebSocketServer({ noServer: true });
  const syncClients = new Set<WebSocket>();

  // Listen for session state changes and broadcast to all sync clients
  sessionManager.on(
    "session_state",
    (payload: { sessionId: string; state: SessionState }) => {
      const message = JSON.stringify({ event: "session_state", data: payload });
      for (const ws of syncClients) {
        if (ws.readyState === ws.OPEN) {
          ws.send(message);
        }
      }
    },
  );

  // Listen for new session creation and broadcast to all sync clients
  sessionManager.on(
    "session_created",
    (payload: { sessionId: string; cwd: string }) => {
      const message = JSON.stringify({
        event: "session_created",
        data: payload,
      });
      for (const ws of syncClients) {
        if (ws.readyState === ws.OPEN) {
          ws.send(message);
        }
      }
    },
  );

  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    const sessionMatch = url.pathname.match(WS_PATH_RE);
    if (sessionMatch) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleConnection(ws, sessionMatch[1], sessionManager);
      });
      return;
    }

    if (WS_SYNC_PATH_RE.test(url.pathname)) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleSyncConnection(ws, syncClients, sessionManager);
      });
      return;
    }

    socket.destroy();
  });
}

async function handleConnection(
  ws: WebSocket,
  sessionId: string,
  sessionManager: SessionManager,
): Promise<void> {
  // Try to subscribe to an active session (replays cache wrapped in batch markers)
  const isActive = sessionManager.subscribeWS(sessionId, ws);

  if (!isActive) {
    // Session is inactive — fetch history from SDK and send via WS
    try {
      const historyEvents =
        await sessionManager.convertHistoryToWSEvents(sessionId);
      sendWS(
        ws,
        controlMsg({
          type: "history_batch_start",
          messageCount: historyEvents.length,
        }),
      );
      for (const evt of historyEvents) {
        sendWS(ws, evt);
      }
      sendWS(ws, controlMsg({ type: "history_batch_end" }));
    } catch {
      sendError(ws, "Failed to load session history", "HISTORY_ERROR");
    }
  }

  ws.on("message", async (raw) => {
    let msg: WSClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      sendError(ws, "Invalid JSON", "INVALID_MESSAGE");
      return;
    }

    if (msg.type === "message") {
      if (!msg.message) {
        sendError(ws, "message field is required", "INVALID_REQUEST");
        return;
      }

      const currentState = sessionManager.getState(sessionId);
      if (currentState === "active") {
        sendError(
          ws,
          "Session is currently processing a message",
          "SESSION_BUSY",
        );
        return;
      }

      try {
        let cwd: string;
        const activeSession = sessionManager.getActiveSession(sessionId);
        if (activeSession) {
          cwd = activeSession.cwd;
        } else {
          // Session is inactive (recycled) — look up cwd from SDK to reactivate
          const allSessions = await listSessions({});
          const info = allSessions.find((s) => s.sessionId === sessionId);
          if (!info?.cwd) {
            sendError(ws, "Session not found", "SESSION_NOT_FOUND");
            return;
          }
          cwd = info.cwd;
        }

        await sessionManager.sendMessage(sessionId, msg.message, cwd);
        // Subscribe via sessionManager to get batch-wrapped cache replay
        sessionManager.subscribeWS(sessionId, ws);
      } catch (err) {
        sendError(
          ws,
          err instanceof Error ? err.message : "Unknown error",
          "SEND_ERROR",
        );
      }
    } else if (msg.type === "answer_question") {
      if (!msg.requestId || !msg.answers) {
        sendError(ws, "requestId and answers are required", "INVALID_REQUEST");
        return;
      }
      const resolved = sessionManager.resolveQuestion(
        sessionId,
        msg.requestId,
        msg.answers,
      );
      if (!resolved) {
        sendError(ws, "No pending question with that requestId", "NOT_FOUND");
      }
    } else {
      sendError(
        ws,
        `Unknown message type: ${(msg as WSClientMessage & { type: string }).type}`,
        "UNKNOWN_TYPE",
      );
    }
  });

  ws.on("close", () => {
    sessionManager.unsubscribeWS(sessionId, ws);
  });
}

function handleSyncConnection(
  ws: WebSocket,
  syncClients: Set<WebSocket>,
  sessionManager: SessionManager,
): void {
  syncClients.add(ws);

  // Send current snapshot of all active/idle session states
  for (const entry of sessionManager.getAllStates()) {
    ws.send(JSON.stringify({ event: "session_state", data: entry }));
  }

  ws.on("close", () => {
    syncClients.delete(ws);
  });
}
