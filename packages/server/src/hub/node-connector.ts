import WebSocket from "ws";
import http from "node:http";
import crypto from "node:crypto";
import type {
  HubToNodeMessage,
  HubToNodeChallengeResponse,
  NodeToHubMessage,
  NodeToHubResponse,
} from "@qoder-anywhere/shared";

interface NodeConnectorOptions {
  hubUrl: string;
  nodeName: string;
  localPort: number;
  accessCode: string;
}

/**
 * NodeConnector connects a local qoder-anywhere server to a hub.
 *
 * Handshake flow (Node verifies Hub):
 * 1. Node connects WS, sends { type: "challenge", nonce }
 * 2. Hub replies { type: "challenge_response", proof: HMAC(nonce, accessCode) }
 * 3. Node verifies proof — if wrong, disconnects immediately
 * 4. Node sends { type: "register", name } to complete handshake
 */
export class NodeConnector {
  private hubUrl: string;
  private nodeName: string;
  private localPort: number;
  private accessCode: string;
  private ws: WebSocket | null = null;
  private localWsConnections = new Map<string, WebSocket>(); // channelId → local WS
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private retryCount = 0;
  private shuttingDown = false;
  private syncWs: WebSocket | null = null;

  constructor(options: NodeConnectorOptions) {
    this.hubUrl = options.hubUrl.replace(/\/$/, "");
    this.nodeName = options.nodeName;
    this.localPort = options.localPort;
    this.accessCode = options.accessCode;
  }

  /** Start the connection to the hub. */
  connect(): void {
    const wsUrl = this.hubUrl.replace(/^http/, "ws") + "/ws/hub/connect";
    console.log(`[node-connector] Connecting to hub at ${wsUrl}...`);

    this.ws = new WebSocket(wsUrl);

    this.ws.on("open", () => {
      console.log(`[node-connector] Connected, verifying hub identity...`);
      this.retryCount = 0;

      // Step 1: Send challenge to hub
      const nonce = crypto.randomBytes(32).toString("hex");
      this.ws!.send(JSON.stringify({ type: "challenge", nonce }));

      // Compute expected proof locally
      const expectedProof = crypto
        .createHmac("sha256", this.accessCode)
        .update(nonce)
        .digest("hex");

      // Wait for hub's challenge_response, then verify
      this.waitForChallengeResponse(expectedProof);
    });

    this.ws.on("close", (code, reason) => {
      const reasonStr = reason.toString();
      if (code === 4003) {
        console.error(`[node-connector] Hub rejected connection: ${reasonStr}`);
        this.shuttingDown = true;
        process.exit(1);
        return;
      }
      console.log(`[node-connector] Disconnected from hub`);
      this.cleanupLocalSync();
      this.cleanupLocalWsConnections();
      if (!this.shuttingDown) {
        this.scheduleReconnect();
      }
    });

    this.ws.on("error", (err) => {
      console.error(`[node-connector] WS error:`, err.message);
    });
  }

  /**
   * After sending the challenge, wait for the hub's response and verify it.
   */
  private waitForChallengeResponse(expectedProof: string): void {
    let verified = false;

    const onMessage = (raw: Buffer | ArrayBuffer | Buffer[]) => {
      if (verified) return;

      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "challenge_response") {
          const resp = msg as HubToNodeChallengeResponse;

          // Verify the hub's proof
          const proofBuf = Buffer.from(resp.proof, "hex");
          const expectedBuf = Buffer.from(expectedProof, "hex");

          if (
            proofBuf.length !== expectedBuf.length ||
            !crypto.timingSafeEqual(proofBuf, expectedBuf)
          ) {
            console.error(
              `[node-connector] Hub identity verification FAILED — access code does not match.`,
            );
            console.error(
              `[node-connector] Disconnecting to protect this machine.`,
            );
            this.ws?.close(4003, "Hub identity verification failed");
            this.shuttingDown = true;
            process.exit(1);
            return;
          }

          // Hub is trusted — complete registration
          verified = true;
          this.ws!.removeListener("message", onMessage);
          console.log(`[node-connector] Hub identity verified ✓`);

          this.ws!.send(
            JSON.stringify({ type: "register", name: this.nodeName }),
          );

          // Now set up normal message handling
          this.setupMessageHandling();
        }
      } catch {
        // ignore
      }
    };

    this.ws!.on("message", onMessage);
  }

  /**
   * Set up normal message handling after handshake is complete.
   */
  private setupMessageHandling(): void {
    let registered = false;

    this.ws!.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        // Wait for registration ack
        if (!registered && msg.type === "registered") {
          registered = true;
          console.log(
            `[node-connector] Registered with hub (nodeId: ${msg.nodeId})`,
          );
          this.connectLocalSync();
          return;
        }

        if (registered) {
          this.handleHubMessage(msg as HubToNodeMessage);
        }
      } catch {
        // ignore
      }
    });
  }

  private send(msg: NodeToHubMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private handleHubMessage(msg: HubToNodeMessage): void {
    switch (msg.type) {
      case "request":
        this.handleProxyRequest(msg);
        break;
      case "ws_open":
        this.handleWsOpen(msg.channelId, msg.path);
        break;
      case "ws_message":
        this.handleWsMessage(msg.channelId, msg.data);
        break;
      case "ws_close":
        this.handleWsClose(msg.channelId);
        break;
    }
  }

  /**
   * Proxy an HTTP request from the hub to the local server.
   */
  private handleProxyRequest(
    msg: HubToNodeMessage & { type: "request" },
  ): void {
    let path = msg.path;
    if (msg.query && Object.keys(msg.query).length > 0) {
      const qs = new URLSearchParams(msg.query).toString();
      path += `?${qs}`;
    }

    const bodyStr =
      msg.body !== undefined ? JSON.stringify(msg.body) : undefined;

    const options: http.RequestOptions = {
      hostname: "127.0.0.1",
      port: this.localPort,
      path,
      method: msg.method,
      headers: {
        "Content-Type": "application/json",
        // Bypass local auth — the hub already authenticated the request
        "X-Internal-Proxy": "node-connector",
        ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
      },
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        let body: unknown;
        try {
          body = JSON.parse(data);
        } catch {
          body = data;
        }

        const response: NodeToHubResponse = {
          type: "response",
          requestId: msg.requestId,
          status: res.statusCode ?? 500,
          body,
        };
        this.send(response);
      });
    });

    req.on("error", (err) => {
      const response: NodeToHubResponse = {
        type: "response",
        requestId: msg.requestId,
        status: 502,
        body: { error: { code: "PROXY_ERROR", message: err.message } },
      };
      this.send(response);
    });

    if (bodyStr) {
      req.write(bodyStr);
    }
    req.end();
  }

  /**
   * Open a local WS connection for a proxied channel.
   */
  private handleWsOpen(channelId: string, path: string): void {
    const wsUrl = `ws://127.0.0.1:${this.localPort}${path}`;
    const localWs = new WebSocket(wsUrl, {
      headers: { "X-Internal-Proxy": "node-connector" },
    });

    localWs.on("open", () => {
      this.localWsConnections.set(channelId, localWs);
      this.send({ type: "ws_open", channelId });
    });

    localWs.on("message", (data) => {
      this.send({
        type: "ws_message",
        channelId,
        data: data.toString(),
      });
    });

    localWs.on("close", (code, reason) => {
      this.localWsConnections.delete(channelId);
      this.send({
        type: "ws_close",
        channelId,
        code,
        reason: reason.toString(),
      });
    });

    localWs.on("error", () => {
      // close will fire
    });
  }

  private handleWsMessage(channelId: string, data: string): void {
    const localWs = this.localWsConnections.get(channelId);
    if (localWs && localWs.readyState === WebSocket.OPEN) {
      localWs.send(data);
    }
  }

  private handleWsClose(channelId: string): void {
    const localWs = this.localWsConnections.get(channelId);
    if (localWs) {
      localWs.close();
      this.localWsConnections.delete(channelId);
    }
  }

  /**
   * Connect to the local sync WS and forward events to hub as sync_events.
   */
  private connectLocalSync(): void {
    const syncUrl = `ws://127.0.0.1:${this.localPort}/ws/sync`;
    this.syncWs = new WebSocket(syncUrl, {
      headers: { "X-Internal-Proxy": "node-connector" },
    });

    this.syncWs.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        // Forward as sync_event to the hub
        this.send({
          type: "sync_event",
          event: msg.event,
          data: msg.data,
        });
      } catch {
        // ignore
      }
    });

    this.syncWs.on("close", () => {
      this.syncWs = null;
    });

    this.syncWs.on("error", () => {
      // close will fire
    });
  }

  private cleanupLocalSync(): void {
    if (this.syncWs) {
      this.syncWs.close();
      this.syncWs = null;
    }
  }

  private cleanupLocalWsConnections(): void {
    for (const [, ws] of this.localWsConnections) {
      ws.close();
    }
    this.localWsConnections.clear();
  }

  private scheduleReconnect(): void {
    const delay = Math.min(1000 * 2 ** this.retryCount, 30_000);
    this.retryCount++;
    console.log(
      `[node-connector] Reconnecting in ${Math.round(delay / 1000)}s...`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  /** Disconnect from hub. */
  shutdown(): void {
    this.shuttingDown = true;
    clearTimeout(this.reconnectTimer);
    this.cleanupLocalSync();
    this.cleanupLocalWsConnections();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
