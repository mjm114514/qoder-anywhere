import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type {
  HubToNodeMessage,
  NodeToHubMessage,
  NodeToHubResponse,
  NodeInfo,
} from "@qoder-anywhere/shared";

export interface ConnectedNode {
  nodeId: string;
  name: string;
  ws: WebSocket;
  connectedAt: number;
  /** Pending HTTP request callbacks */
  pendingRequests: Map<
    string,
    {
      resolve: (resp: NodeToHubResponse) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >;
  /** Active proxied WS channels */
  wsChannels: Map<string, WebSocket>; // channelId → hub-side client WS
}

const REQUEST_TIMEOUT_MS = 120_000; // 2 minutes

/**
 * Manages connected nodes in hub mode.
 * Hub is a pure proxy — no caching, no polling. Frontend fetches on demand.
 *
 * Events:
 * - "node_connected" (nodeId: string, name: string)
 * - "node_disconnected" (nodeId: string)
 * - "sync_event" (nodeId: string, event: string, data: unknown)
 */
export class HubNodeManager extends EventEmitter {
  private nodes = new Map<string, ConnectedNode>();

  /** Register a new node connection. */
  registerNode(ws: WebSocket, name: string): string {
    const nodeId = randomUUID().slice(0, 8);
    const node: ConnectedNode = {
      nodeId,
      name,
      ws,
      connectedAt: Date.now(),
      pendingRequests: new Map(),
      wsChannels: new Map(),
    };

    this.nodes.set(nodeId, node);

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as NodeToHubMessage;
        this.handleNodeMessage(nodeId, msg);
      } catch {
        // ignore parse errors
      }
    });

    ws.on("close", () => {
      this.handleNodeDisconnect(nodeId);
    });

    ws.on("error", () => {
      // close will fire after error
    });

    this.emit("node_connected", nodeId, name);

    return nodeId;
  }

  private handleNodeMessage(nodeId: string, msg: NodeToHubMessage): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;

    switch (msg.type) {
      case "response": {
        const pending = node.pendingRequests.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          node.pendingRequests.delete(msg.requestId);
          pending.resolve(msg);
        }
        break;
      }
      case "ws_open": {
        // Node opened a proxied WS channel — nothing special needed
        break;
      }
      case "ws_message": {
        // Forward from node's session WS → hub's client WS
        const clientWs = node.wsChannels.get(msg.channelId);
        if (clientWs && clientWs.readyState === clientWs.OPEN) {
          clientWs.send(msg.data);
        }
        break;
      }
      case "ws_close": {
        const clientWs = node.wsChannels.get(msg.channelId);
        if (clientWs) {
          clientWs.close(msg.code ?? 1000, msg.reason ?? "");
          node.wsChannels.delete(msg.channelId);
        }
        break;
      }
      case "sync_event": {
        this.emit("sync_event", nodeId, msg.event, msg.data);
        break;
      }
      case "register": {
        // Late registration (name update)
        node.name = msg.name;
        break;
      }
    }
  }

  private handleNodeDisconnect(nodeId: string): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;

    // Clean up pending requests
    for (const [, pending] of node.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Node disconnected"));
    }
    node.pendingRequests.clear();

    // Close all proxied WS channels
    for (const [, clientWs] of node.wsChannels) {
      if (clientWs.readyState === clientWs.OPEN) {
        clientWs.close(1001, "Node disconnected");
      }
    }
    node.wsChannels.clear();

    this.nodes.delete(nodeId);
    this.emit("node_disconnected", nodeId);
  }

  /** Send a message to a specific node. */
  sendToNode(nodeId: string, msg: HubToNodeMessage): void {
    const node = this.nodes.get(nodeId);
    if (!node || node.ws.readyState !== node.ws.OPEN) {
      throw new Error(`Node ${nodeId} not connected`);
    }
    node.ws.send(JSON.stringify(msg));
  }

  /**
   * Send an HTTP-like request to a node and wait for the response.
   */
  async proxyRequest(
    nodeId: string,
    method: string,
    path: string,
    query?: Record<string, string>,
    body?: unknown,
  ): Promise<NodeToHubResponse> {
    const node = this.nodes.get(nodeId);
    if (!node || node.ws.readyState !== node.ws.OPEN) {
      throw new Error(`Node ${nodeId} not connected`);
    }

    const requestId = randomUUID();
    return new Promise<NodeToHubResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        node.pendingRequests.delete(requestId);
        reject(new Error("Request timed out"));
      }, REQUEST_TIMEOUT_MS);

      node.pendingRequests.set(requestId, { resolve, reject, timer });

      this.sendToNode(nodeId, {
        type: "request",
        requestId,
        method,
        path,
        query,
        body,
      });
    });
  }

  /**
   * Open a proxied WS channel: hub client ↔ hub ↔ node.
   * Returns the channelId. The hub's client WS is stored so messages can be forwarded.
   */
  openWsChannel(nodeId: string, path: string, clientWs: WebSocket): string {
    const node = this.nodes.get(nodeId);
    if (!node || node.ws.readyState !== node.ws.OPEN) {
      throw new Error(`Node ${nodeId} not connected`);
    }

    const channelId = randomUUID();
    node.wsChannels.set(channelId, clientWs);

    // Tell the node to open a WS
    this.sendToNode(nodeId, {
      type: "ws_open",
      channelId,
      path,
    });

    // Forward client → node
    clientWs.on("message", (raw) => {
      if (node.ws.readyState === node.ws.OPEN) {
        this.sendToNode(nodeId, {
          type: "ws_message",
          channelId,
          data: raw.toString(),
        });
      }
    });

    clientWs.on("close", () => {
      node.wsChannels.delete(channelId);
      if (node.ws.readyState === node.ws.OPEN) {
        this.sendToNode(nodeId, {
          type: "ws_close",
          channelId,
        });
      }
    });

    return channelId;
  }

  /** Get info about all connected nodes. */
  getNodes(): NodeInfo[] {
    return [...this.nodes.values()].map((n) => ({
      nodeId: n.nodeId,
      name: n.name,
      connectedAt: n.connectedAt,
    }));
  }

  getNode(nodeId: string): ConnectedNode | undefined {
    return this.nodes.get(nodeId);
  }

  getNodeCount(): number {
    return this.nodes.size;
  }

  /** Shut down — disconnect all nodes. */
  shutdown(): void {
    for (const [nodeId, node] of this.nodes) {
      for (const [, pending] of node.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Hub shutting down"));
      }
      node.ws.close(1001, "Hub shutting down");
      this.nodes.delete(nodeId);
    }
  }
}
