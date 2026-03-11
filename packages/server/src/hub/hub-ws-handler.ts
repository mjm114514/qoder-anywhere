import { WebSocketServer, type WebSocket } from "ws";
import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Server } from "node:http";
import type { AuthConfig } from "../auth/config.js";
import { verifyWsUpgrade } from "../auth/middleware.js";
import { HubNodeManager } from "./hub-node-manager.js";
import type {
  NodeToHubChallenge,
  NodeToHubRegister,
} from "@lgtm-anywhere/shared";

// Hub WS paths:
// /ws/hub/connect              — node connects to hub (node ↔ hub link)
// /ws/node/:node_id/sessions/:session_id — client WS proxied through to node
// /ws/node/:node_id/sync       — client sync WS proxied through to node
// /ws/node/:node_id/terminal/:terminal_id — client terminal WS proxied to node
// /ws/sync                     — hub-level sync (aggregated from all nodes)

const HUB_CONNECT_RE = /^\/ws\/hub\/connect$/;
const NODE_SESSION_WS_RE = /^\/ws\/node\/([^/]+)\/sessions\/([^/]+)$/;
const NODE_SYNC_WS_RE = /^\/ws\/node\/([^/]+)\/sync$/;
const NODE_TERMINAL_WS_RE = /^\/ws\/node\/([^/]+)\/terminal\/([^/]+)$/;
const HUB_SYNC_RE = /^\/ws\/sync$/;

export function attachHubWebSocket(
  server: Server,
  nodeManager: HubNodeManager,
  authConfig: AuthConfig,
): void {
  const wss = new WebSocketServer({ noServer: true });
  const hubSyncClients = new Set<WebSocket>();

  // Broadcast node-level sync events to hub sync clients
  nodeManager.on(
    "sync_event",
    (nodeId: string, event: string, data: unknown) => {
      const message = JSON.stringify({
        event,
        data: { ...(data as Record<string, unknown>), nodeId },
      });
      for (const ws of hubSyncClients) {
        if (ws.readyState === ws.OPEN) {
          ws.send(message);
        }
      }
    },
  );

  nodeManager.on("node_connected", (nodeId: string, name: string) => {
    const message = JSON.stringify({
      event: "node_connected",
      data: { nodeId, name },
    });
    for (const ws of hubSyncClients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(message);
      }
    }
  });

  nodeManager.on("node_disconnected", (nodeId: string) => {
    const message = JSON.stringify({
      event: "node_disconnected",
      data: { nodeId },
    });
    for (const ws of hubSyncClients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(message);
      }
    }
  });

  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    // Node connecting to hub — no browser auth needed (uses challenge-response)
    const hubConnectMatch = url.pathname.match(HUB_CONNECT_RE);
    if (hubConnectMatch) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleNodeConnect(ws, nodeManager, authConfig);
      });
      return;
    }

    // All other WS paths require browser auth
    if (!verifyWsUpgrade(req, authConfig)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    // Client WS proxied to node session
    const sessionMatch = url.pathname.match(NODE_SESSION_WS_RE);
    if (sessionMatch) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleProxiedWs(
          ws,
          sessionMatch[1],
          `/ws/sessions/${sessionMatch[2]}`,
          nodeManager,
        );
      });
      return;
    }

    // Client sync WS proxied to node
    const syncMatch = url.pathname.match(NODE_SYNC_WS_RE);
    if (syncMatch) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleProxiedWs(ws, syncMatch[1], "/ws/sync", nodeManager);
      });
      return;
    }

    // Client terminal WS proxied to node
    const termMatch = url.pathname.match(NODE_TERMINAL_WS_RE);
    if (termMatch) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleProxiedWs(
          ws,
          termMatch[1],
          `/ws/terminal/${termMatch[2]}`,
          nodeManager,
        );
      });
      return;
    }

    // Hub-level sync
    if (HUB_SYNC_RE.test(url.pathname)) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleHubSync(ws, hubSyncClients, nodeManager);
      });
      return;
    }

    socket.destroy();
  });
}

/**
 * Handle a node connecting to the hub.
 *
 * Handshake (Node verifies Hub's identity):
 * 1. Node sends { type: "challenge", nonce: "<random>" }
 * 2. Hub replies { type: "challenge_response", proof: HMAC(nonce, accessCode) }
 * 3. Node verifies the HMAC locally — if it matches, Hub is trusted
 * 4. Node sends { type: "register", name: "hostname" }
 * 5. Hub registers the node and sends { type: "registered", nodeId }
 */
function handleNodeConnect(
  ws: WebSocket,
  nodeManager: HubNodeManager,
  authConfig: AuthConfig,
): void {
  let challengeAnswered = false;
  let registered = false;

  const onMessage = (raw: Buffer | ArrayBuffer | Buffer[]) => {
    try {
      const msg = JSON.parse(raw.toString());

      // Step 1: Node sends challenge
      if (!challengeAnswered && msg.type === "challenge") {
        const challenge = msg as NodeToHubChallenge;
        challengeAnswered = true;

        // Compute proof: HMAC-SHA256(nonce, accessCode)
        const proof = authConfig.enabled
          ? crypto
              .createHmac("sha256", authConfig.authToken)
              .update(challenge.nonce)
              .digest("hex")
          : "no-auth";

        ws.send(JSON.stringify({ type: "challenge_response", proof }));
        return;
      }

      // Step 2: Node sends register (after verifying the proof locally)
      if (challengeAnswered && !registered && msg.type === "register") {
        const reg = msg as NodeToHubRegister;
        registered = true;
        ws.removeListener("message", onMessage);
        const nodeId = nodeManager.registerNode(ws, reg.name);
        console.log(`[hub] Node "${reg.name}" connected (id: ${nodeId})`);
        ws.send(JSON.stringify({ type: "registered", nodeId }));
      }
    } catch {
      // ignore
    }
  };

  ws.on("message", onMessage);

  // Timeout — if handshake not completed in 10s, close
  const timeout = setTimeout(() => {
    if (!registered) {
      ws.close(4001, "Handshake timeout");
    }
  }, 10_000);

  ws.on("close", () => {
    clearTimeout(timeout);
  });
}

/**
 * Proxy a client WS connection through to a node.
 */
function handleProxiedWs(
  clientWs: WebSocket,
  nodeId: string,
  targetPath: string,
  nodeManager: HubNodeManager,
): void {
  try {
    nodeManager.openWsChannel(nodeId, targetPath, clientWs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to open channel";
    clientWs.close(4004, msg);
  }
}

/**
 * Hub-level sync WS: aggregates events from all nodes.
 */
function handleHubSync(
  ws: WebSocket,
  syncClients: Set<WebSocket>,
  nodeManager: HubNodeManager,
): void {
  syncClients.add(ws);

  // Send current snapshot of all nodes
  for (const node of nodeManager.getNodes()) {
    ws.send(
      JSON.stringify({
        event: "node_connected",
        data: { nodeId: node.nodeId, name: node.name },
      }),
    );
  }

  ws.on("close", () => {
    syncClients.delete(ws);
  });
}
