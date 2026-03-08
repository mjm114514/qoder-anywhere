import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Server } from "node:http";
import type { WSClientMessage } from "@lgtm-anywhere/shared";
import { SessionManager } from "../services/session-manager.js";

const WS_PATH_RE = /^\/ws\/sessions\/([^/]+)$/;

export function attachWebSocket(server: Server, sessionManager: SessionManager): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const match = url.pathname.match(WS_PATH_RE);

    if (!match) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const sessionId = match[1];
      handleConnection(ws, sessionId, sessionManager);
    });
  });
}

function sendError(ws: WebSocket, error: string, code: string): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ event: "error", data: { error, code } }));
  }
}

function handleConnection(
  ws: WebSocket,
  sessionId: string,
  sessionManager: SessionManager
): void {
  // Subscribe this WS client to the session's broadcast
  sessionManager.subscribeWS(sessionId, ws);

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
        sendError(ws, "Session is currently processing a message", "SESSION_BUSY");
        return;
      }

      try {
        // Get cwd from the active session (must exist since WS is subscribed)
        const activeSession = sessionManager.getActiveSession(sessionId);
        if (!activeSession) {
          sendError(ws, "Session is not active, send a message via REST to reactivate", "SESSION_INACTIVE");
          return;
        }

        const session = await sessionManager.sendMessage(sessionId, msg.message, activeSession.cwd);
        // Ensure this WS is subscribed (may be a new session after reactivation)
        session.wsClients.add(ws);
      } catch (err) {
        sendError(
          ws,
          err instanceof Error ? err.message : "Unknown error",
          "SEND_ERROR"
        );
      }
    } else {
      sendError(ws, `Unknown message type: ${(msg as any).type}`, "UNKNOWN_TYPE");
    }
  });

  ws.on("close", () => {
    sessionManager.unsubscribeWS(sessionId, ws);
  });
}
