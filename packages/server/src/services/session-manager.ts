import { query, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import type { SessionState } from "@lgtm-anywhere/shared";
import { config } from "../config.js";
import { MessageQueue } from "./message-queue.js";

export interface ActiveSession {
  sessionId: string;
  cwd: string;
  query: Query;
  messageQueue: MessageQueue;
  abortController: AbortController;
  state: "active" | "idle";
  model?: string;
  createdAt: number;
  lastActivityAt: number;
  wsClients: Set<WebSocket>;
  /** Resolves with the sessionId once the SDK init message arrives */
  sessionIdReady: Promise<string>;
  /** Call this to resolve sessionIdReady (set internally) */
  resolveSessionId: (id: string) => void;
}

export interface CreateSessionOptions {
  message: string;
  model?: string;
  permissionMode?: string;
  allowedTools?: string[];
  systemPrompt?: string;
  maxTurns?: number;
}

function makeSessionIdHook(): Pick<ActiveSession, "sessionIdReady" | "resolveSessionId"> {
  let resolveSessionId!: (id: string) => void;
  const sessionIdReady = new Promise<string>((resolve) => {
    resolveSessionId = resolve;
  });
  return { sessionIdReady, resolveSessionId };
}

export class SessionManager extends EventEmitter {
  private activeSessions = new Map<string, ActiveSession>();
  private recycleTimer: ReturnType<typeof setInterval>;

  constructor() {
    super();
    this.recycleTimer = setInterval(() => this.recycle(), config.recycleIntervalMs);
  }

  getState(sessionId: string): SessionState {
    const session = this.activeSessions.get(sessionId);
    if (!session) return "inactive";
    return session.state;
  }

  getAllStates(): Array<{ sessionId: string; state: SessionState }> {
    return Array.from(this.activeSessions.values()).map((s) => ({
      sessionId: s.sessionId,
      state: s.state,
    }));
  }

  getActiveSession(sessionId: string): ActiveSession | undefined {
    return this.activeSessions.get(sessionId);
  }

  async createSession(
    cwd: string,
    options: CreateSessionOptions
  ): Promise<ActiveSession> {
    const messageQueue = new MessageQueue();
    const abortController = new AbortController();

    console.log("start query")
    const q = query({
      prompt: messageQueue,
      options: {
        cwd,
        model: options.model,
        permissionMode: (options.permissionMode as any) ?? "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        allowedTools: options.allowedTools,
        systemPrompt: options.systemPrompt,
        maxTurns: options.maxTurns,
        abortController,
        includePartialMessages: true,
      },
    });
    console.log("query created")

    const { sessionIdReady, resolveSessionId } = makeSessionIdHook();

    const session: ActiveSession = {
      sessionId: "", // will be set from init message
      cwd,
      query: q,
      messageQueue,
      abortController,
      state: "active",
      model: options.model,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      wsClients: new Set(),
      sessionIdReady,
      resolveSessionId,
    };

    // Push the first user message immediately
    session.messageQueue.push(options.message);

    // Start consuming messages in the background (handles init + ongoing)
    this.runSession(session, q);

    console.log("session created, waiting for sessionId via sessionIdReady")
    return session;
  }

  async sendMessage(
    sessionId: string,
    message: string,
    cwd: string
  ): Promise<ActiveSession> {
    let session = this.activeSessions.get(sessionId);

    if (!session) {
      // Reactivate: waits for init, then pushes message
      session = await this.reactivateSession(sessionId, cwd, message);
    } else {
      // Session already active/idle — transport is ready, safe to push
      session.messageQueue.push(message);
    }

    session.state = "active";
    session.lastActivityAt = Date.now();
    this.emit("session_state", { sessionId: session.sessionId, state: "active" as SessionState });

    return session;
  }

  private async reactivateSession(
    sessionId: string,
    cwd: string,
    firstMessage: string
  ): Promise<ActiveSession> {
    const messageQueue = new MessageQueue();
    const abortController = new AbortController();

    const q = query({
      prompt: messageQueue,
      options: {
        resume: sessionId,
        cwd,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        abortController,
        includePartialMessages: true,
      },
    });

    // sessionId is already known for reactivation — resolve immediately
    const { sessionIdReady, resolveSessionId } = makeSessionIdHook();
    resolveSessionId(sessionId);

    const session: ActiveSession = {
      sessionId,
      cwd,
      query: q,
      messageQueue,
      abortController,
      state: "active",
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      wsClients: new Set(),
      sessionIdReady,
      resolveSessionId,
    };

    this.activeSessions.set(sessionId, session);
    this.emit("session_state", { sessionId, state: "active" as SessionState });

    // Push the first message immediately
    session.messageQueue.push(firstMessage);

    // Start consuming in the background (init will be handled inline)
    this.runSession(session, q);

    return session;
  }

  subscribeWS(sessionId: string, ws: WebSocket): void {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      session.wsClients.add(ws);
    }
  }

  unsubscribeWS(sessionId: string, ws: WebSocket): void {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      session.wsClients.delete(ws);
    }
  }

  async stopSession(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    // Close all WebSocket connections
    for (const ws of session.wsClients) {
      this.sendWS(ws, "error", { error: "Session stopped", code: "SESSION_STOPPED" });
      ws.close();
    }
    session.wsClients.clear();

    // Close message queue and query
    session.messageQueue.close();
    session.query.close();

    this.activeSessions.delete(sessionId);
    this.emit("session_state", { sessionId, state: "inactive" as SessionState });
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      await session.query.setModel(model);
      session.model = model;
    }
  }

  private sendWS(ws: WebSocket, event: string, data: unknown): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ event, data }));
    }
  }

  private broadcast(session: ActiveSession, event: string, data: unknown): void {
    const message = JSON.stringify({ event, data });
    for (const ws of session.wsClients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(message);
      }
    }
  }

  private mapMessageToEvent(message: SDKMessage): { event: string; data: unknown } | null {
    switch (message.type) {
      case "system":
        if ("subtype" in message && message.subtype === "init") {
          return {
            event: "init",
            data: {
              sessionId: message.session_id,
              cwd: (message as any).cwd,
              model: (message as any).model,
            },
          };
        }
        return null;

      case "assistant":
        return {
          event: "assistant",
          data: {
            type: "assistant",
            uuid: message.uuid,
            message: (message as any).message,
          },
        };

      case "stream_event":
        return {
          event: "stream_event",
          data: {
            type: "stream_event",
            event: (message as any).event,
            parent_tool_use_id: (message as any).parent_tool_use_id,
          },
        };

      case "user":
        // Tool results
        if ((message as any).tool_use_result !== undefined) {
          return {
            event: "tool_result",
            data: {
              type: "user",
              uuid: message.uuid,
              message: (message as any).message,
              tool_use_result: (message as any).tool_use_result,
            },
          };
        }
        return null;

      case "result":
        return {
          event: "result",
          data: {
            subtype: (message as any).subtype,
            result: (message as any).result,
            session_id: message.session_id,
            total_cost_usd: (message as any).total_cost_usd,
            duration_ms: (message as any).duration_ms,
            num_turns: (message as any).num_turns,
            errors: (message as any).errors,
          },
        };

      default: {
        // tool_progress, status, etc. — forward as-is
        const type = (message as any).type;
        if (type === "tool_progress" || type === "status") {
          return { event: type, data: message };
        }
        return null;
      }
    }
  }

  /**
   * Continuously consume messages from the query and broadcast to WS clients.
   * Also handles the init message (sets sessionId, registers in map).
   * Runs in the background (not awaited).
   */
  private async runSession(session: ActiveSession, q: Query): Promise<void> {
    try {
      for await (const message of q) {
        // Handle init message: set sessionId and register
        if (
          message.type === "system" &&
          "subtype" in message &&
          message.subtype === "init"
        ) {
          if (!session.sessionId) {
            session.sessionId = message.session_id;
            this.activeSessions.set(session.sessionId, session);
            this.emit("session_state", { sessionId: session.sessionId, state: "active" as SessionState });
          }
          session.resolveSessionId(message.session_id);
        }

        const mapped = this.mapMessageToEvent(message);
        if (mapped) {
          this.broadcast(session, mapped.event, mapped.data);
        }

        // result means this turn is done → IDLE
        if (message.type === "result") {
          session.state = "idle";
          session.lastActivityAt = Date.now();
          this.emit("session_state", { sessionId: session.sessionId, state: "idle" as SessionState });
          // Don't break — generator stays alive, waiting for next message from queue
        }
      }
    } catch (err) {
      this.broadcast(session, "error", {
        error: err instanceof Error ? err.message : "Unknown error",
        code: "QUERY_ERROR",
      });
    }

    // Generator exited → process terminated
    this.activeSessions.delete(session.sessionId);
    this.emit("session_state", { sessionId: session.sessionId, state: "inactive" as SessionState });
  }

  private recycle(): void {
    const now = Date.now();
    for (const [sessionId, session] of this.activeSessions) {
      if (
        session.state === "idle" &&
        now - session.lastActivityAt > config.idleTimeoutMs
      ) {
        console.log(`[recycle] Stopping idle session ${sessionId}`);
        this.stopSession(sessionId);
      }
    }
  }

  async shutdown(): Promise<void> {
    clearInterval(this.recycleTimer);
    const stops = Array.from(this.activeSessions.keys()).map((id) =>
      this.stopSession(id)
    );
    await Promise.all(stops);
  }
}
