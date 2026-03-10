import {
  query,
  getSessionMessages,
  type Query,
  type SDKMessage,
  type CanUseTool,
  type SDKAssistantMessage,
  type SDKUserMessage,
  type SDKUserMessageReplay,
  type PermissionMode,
} from "@anthropic-ai/claude-agent-sdk";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type WebSocket from "ws";
import type {
  SessionState,
  AskUserQuestionItem,
  TodoItem,
  WSServerMessage,
  WSSdkMessage,
  WSControlMessage,
  ControlPayload,
} from "@lgtm-anywhere/shared";
import { config } from "../config.js";
import { MessageQueue } from "./message-queue.js";

// ── Envelope helpers ──

function sdkMsg(message: SDKMessage): WSSdkMessage {
  return { category: "sdk", message };
}

function controlMsg(message: ControlPayload): WSControlMessage {
  return { category: "control", message };
}

/**
 * Extract the effective "kind" of an SDK message in the cache.
 * For system messages, returns the subtype (e.g., "init", "task_started").
 * For other SDK messages, returns the type (e.g., "assistant", "stream_event").
 * Returns null for control messages.
 */
function sdkMessageKind(entry: WSServerMessage): string | null {
  if (entry.category !== "sdk") return null;
  const m = entry.message;
  if (m.type === "system" && "subtype" in m) return m.subtype as string;
  return m.type;
}

/**
 * Determine whether an SDK message should be forwarded (cached + broadcast).
 * Returns false for messages we intentionally drop or handle separately.
 */
function shouldForwardSdkMessage(message: SDKMessage): boolean {
  switch (message.type) {
    case "system": {
      const sub = "subtype" in message ? message.subtype : undefined;
      if (sub === "init") return true;
      if (sub === "status") return false; // transient — handled separately
      if (
        sub === "task_started" ||
        sub === "task_progress" ||
        sub === "task_notification"
      ) {
        // Only forward task messages that have a tool_use_id (subagent tasks)
        return !!(message as { tool_use_id?: string }).tool_use_id;
      }
      return false;
    }
    case "assistant":
    case "stream_event":
    case "tool_progress":
    case "result":
      return true;
    case "user": {
      const userMsg = message as SDKUserMessage | SDKUserMessageReplay;
      return userMsg.tool_use_result !== undefined;
    }
    default:
      return false;
  }
}

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
  /** Pending AskUserQuestion requests awaiting user answers */
  pendingQuestions: Map<
    string,
    {
      input: Record<string, unknown>;
      resolve: (answers: Record<string, string>) => void;
    }
  >;
  /** Full cache of WS messages (history + runtime) for the session lifetime */
  messageCache: WSServerMessage[];
  /** Current todo list maintained via TodoWrite tool interceptions */
  currentTodos: TodoItem[];
}

export interface CreateSessionOptions {
  message: string;
  model?: string;
  permissionMode?: string;
  allowedTools?: string[];
  systemPrompt?: string;
  maxTurns?: number;
}

function makeSessionIdHook(): Pick<
  ActiveSession,
  "sessionIdReady" | "resolveSessionId"
> {
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
    this.recycleTimer = setInterval(
      () => this.recycle(),
      config.recycleIntervalMs,
    );
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

  /** Return all in-memory active sessions whose cwd matches. */
  getActiveSessionsByCwd(cwd: string): ActiveSession[] {
    const result: ActiveSession[] = [];
    for (const session of this.activeSessions.values()) {
      if (session.sessionId && session.cwd === cwd) {
        result.push(session);
      }
    }
    return result;
  }

  async createSession(
    cwd: string,
    options: CreateSessionOptions,
  ): Promise<ActiveSession> {
    const messageQueue = new MessageQueue();
    const abortController = new AbortController();

    const { sessionIdReady, resolveSessionId } = makeSessionIdHook();

    const session: ActiveSession = {
      sessionId: "", // will be set from init message
      cwd,
      query: null as unknown as Query, // set below after canUseTool is ready
      messageQueue,
      abortController,
      state: "active",
      model: options.model,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      wsClients: new Set(),
      sessionIdReady,
      resolveSessionId,
      pendingQuestions: new Map(),
      messageCache: [],
      currentTodos: [],
    };

    console.log("start query");
    const q = query({
      prompt: messageQueue,
      options: {
        cwd,
        model: options.model,
        permissionMode:
          (options.permissionMode as PermissionMode) ?? "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        allowedTools: options.allowedTools,
        systemPrompt: options.systemPrompt,
        maxTurns: options.maxTurns,
        abortController,
        includePartialMessages: true,
        canUseTool: this.makeCanUseTool(session),
      },
    });
    console.log("query created");

    session.query = q;

    // Push the first user message immediately
    session.messageQueue.push(options.message);

    // Cache the first user message (not yet persisted)
    session.messageCache.push(
      controlMsg({ type: "session_message", message: options.message }),
    );

    // Start consuming messages in the background (handles init + ongoing)
    this.runSession(session, q);

    console.log("session created, waiting for sessionId via sessionIdReady");
    return session;
  }

  async sendMessage(
    sessionId: string,
    message: string,
    cwd: string,
  ): Promise<ActiveSession> {
    let session = this.activeSessions.get(sessionId);

    if (!session) {
      // Reactivate: waits for init, then pushes message
      session = await this.reactivateSession(sessionId, cwd, message);
    } else {
      // Session already active/idle — transport is ready, safe to push
      session.messageQueue.push(message);
    }

    // Cache and broadcast the user message (not yet persisted by SDK).
    const pending = controlMsg({ type: "session_message", message });
    session.messageCache.push(pending);
    this.broadcast(session, pending);

    session.state = "active";
    session.lastActivityAt = Date.now();
    this.emit("session_state", {
      sessionId: session.sessionId,
      state: "active" as SessionState,
    });

    return session;
  }

  private async reactivateSession(
    sessionId: string,
    cwd: string,
    firstMessage: string,
  ): Promise<ActiveSession> {
    const messageQueue = new MessageQueue();
    const abortController = new AbortController();

    // sessionId is already known for reactivation — resolve immediately
    const { sessionIdReady, resolveSessionId } = makeSessionIdHook();
    resolveSessionId(sessionId);

    const session: ActiveSession = {
      sessionId,
      cwd,
      query: null as unknown as Query,
      messageQueue,
      abortController,
      state: "active",
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      wsClients: new Set(),
      sessionIdReady,
      resolveSessionId,
      pendingQuestions: new Map(),
      messageCache: [],
      currentTodos: [],
    };

    const q = query({
      prompt: messageQueue,
      options: {
        resume: sessionId,
        cwd,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        abortController,
        includePartialMessages: true,
        canUseTool: this.makeCanUseTool(session),
      },
    });

    session.query = q;

    this.activeSessions.set(sessionId, session);
    this.emit("session_state", { sessionId, state: "active" as SessionState });

    // Seed cache with history so WS subscribers get full conversation on replay
    const historyEvents = await this.convertHistoryToWSEvents(sessionId);
    session.messageCache = historyEvents;

    // Push the first message immediately (caching is handled by sendMessage)
    session.messageQueue.push(firstMessage);

    // Start consuming in the background (init will be handled inline)
    this.runSession(session, q);

    return session;
  }

  subscribeWS(sessionId: string, ws: WebSocket): boolean {
    const session = this.activeSessions.get(sessionId);
    if (!session) return false;

    // Replay cached messages wrapped in batch markers
    this.sendWS(
      ws,
      controlMsg({
        type: "history_batch_start",
        messageCount: session.messageCache.length,
      }),
    );
    for (const cached of session.messageCache) {
      this.sendWS(ws, cached);
    }
    this.sendWS(ws, controlMsg({ type: "history_batch_end" }));

    session.wsClients.add(ws);
    return true;
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
    const errMsg = controlMsg({
      type: "error",
      error: "Session stopped",
      code: "SESSION_STOPPED",
    });
    for (const ws of session.wsClients) {
      this.sendWS(ws, errMsg);
      ws.close();
    }
    session.wsClients.clear();

    // Close message queue and query
    session.messageQueue.close();
    session.query.close();

    this.activeSessions.delete(sessionId);
    this.emit("session_state", {
      sessionId,
      state: "inactive" as SessionState,
    });
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      await session.query.setModel(model);
      session.model = model;
    }
  }

  /**
   * Resolve a pending AskUserQuestion request with user-provided answers.
   */
  resolveQuestion(
    sessionId: string,
    requestId: string,
    answers: Record<string, string>,
  ): boolean {
    const session = this.activeSessions.get(sessionId);
    if (!session) return false;
    const pending = session.pendingQuestions.get(requestId);
    if (!pending) return false;
    pending.resolve(answers);
    session.pendingQuestions.delete(requestId);
    return true;
  }

  /**
   * Convert persisted session messages from the SDK into WS messages for replay.
   */
  async convertHistoryToWSEvents(
    sessionId: string,
  ): Promise<WSServerMessage[]> {
    const messages = await getSessionMessages(sessionId, { limit: 1000 });
    const events: WSServerMessage[] = [];
    let lastTodos: TodoItem[] | null = null;

    for (const m of messages) {
      if (m.type === "assistant") {
        // Reconstruct as SDK-shaped message for passthrough
        events.push(
          sdkMsg({
            type: "assistant",
            uuid: m.uuid,
            message: m.message,
            parent_tool_use_id: m.parent_tool_use_id ?? null,
            session_id: m.session_id ?? sessionId,
          } as SDKAssistantMessage),
        );

        // Scan assistant message content blocks for the last TodoWrite tool_use
        const msg = m.message as Record<string, unknown> | undefined;
        if (msg && Array.isArray(msg.content)) {
          for (const block of msg.content as Array<Record<string, unknown>>) {
            if (block.type === "tool_use" && block.name === "TodoWrite") {
              const blockInput = block.input as
                | Record<string, unknown>
                | undefined;
              if (blockInput && Array.isArray(blockInput.todos)) {
                lastTodos = blockInput.todos as TodoItem[];
              }
            }
          }
        }
      } else if (m.type === "user") {
        if (isToolResultMessage(m.message)) {
          events.push(
            sdkMsg({
              type: "user",
              uuid: m.uuid,
              message: m.message,
              parent_tool_use_id: m.parent_tool_use_id ?? null,
              session_id: m.session_id ?? sessionId,
            } as unknown as SDKUserMessage),
          );
        } else {
          const text = extractUserText(m.message);
          if (text) {
            events.push(controlMsg({ type: "session_message", message: text }));
          }
        }
      }
    }

    // Append the last todo state so clients can restore the todo panel
    if (lastTodos) {
      events.push(controlMsg({ type: "todo_update", todos: lastTodos }));
    }

    return events;
  }

  /**
   * Build a canUseTool callback for a session.
   * Intercepts AskUserQuestion to broadcast to WS clients and wait for user answer.
   */
  private makeCanUseTool(session: ActiveSession): CanUseTool {
    return async (toolName, input, _options) => {
      if (toolName === "AskUserQuestion") {
        const requestId = randomUUID();
        const questions = (input.questions ?? []) as AskUserQuestionItem[];

        // Cache & broadcast question to all connected WS clients
        const cached = controlMsg({
          type: "ask_user_question",
          requestId,
          questions,
        });
        session.messageCache.push(cached);
        this.broadcast(session, cached);

        // Wait for the user to answer
        const answers = await new Promise<Record<string, string>>((resolve) => {
          session.pendingQuestions.set(requestId, { input, resolve });
        });

        // Remove the cached question so it won't replay after being answered
        const idx = session.messageCache.indexOf(cached);
        if (idx !== -1) session.messageCache.splice(idx, 1);

        return {
          behavior: "allow" as const,
          updatedInput: {
            questions: input.questions,
            answers,
          },
        };
      }

      // All other tools: allow (bypassPermissions handles the rest)
      return { behavior: "allow" as const };
    };
  }

  private sendWS(ws: WebSocket, msg: WSServerMessage): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  private broadcast(session: ActiveSession, msg: WSServerMessage): void {
    const serialized = JSON.stringify(msg);
    for (const ws of session.wsClients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(serialized);
      }
    }
  }

  /**
   * Remove all cached SDK messages of the given kind from the cache.
   * Called when a finalized message arrives that supersedes transient events
   * (e.g., stream_event deltas are superseded by the complete assistant message).
   */
  private pruneSdkMessages(cache: WSServerMessage[], kind: string): void {
    for (let i = cache.length - 2; i >= 0; i--) {
      if (sdkMessageKind(cache[i]) === kind) {
        cache.splice(i, 1);
      }
    }
  }

  /**
   * Remove cached SDK messages matching a predicate.
   * Used for targeted pruning (e.g., removing task_progress for a specific task_id).
   */
  private pruneSdkMessagesByPredicate(
    cache: WSServerMessage[],
    predicate: (entry: WSServerMessage) => boolean,
  ): void {
    for (let i = cache.length - 2; i >= 0; i--) {
      if (predicate(cache[i])) {
        cache.splice(i, 1);
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
            this.emit("session_state", {
              sessionId: session.sessionId,
              state: "active" as SessionState,
            });
            this.emit("session_created", {
              sessionId: session.sessionId,
              cwd: session.cwd,
            });
          }
          session.resolveSessionId(message.session_id);
        }

        // Status events are transient — broadcast live but don't cache
        // (they have no replay value for reconnecting clients)
        if (
          message.type === "system" &&
          "subtype" in message &&
          message.subtype === "status"
        ) {
          this.broadcast(session, sdkMsg(message));
          continue;
        }

        // Forward SDK messages that pass the filter
        if (shouldForwardSdkMessage(message)) {
          const wrapped = sdkMsg(message);
          session.messageCache.push(wrapped);

          // When a complete assistant message arrives, remove preceding
          // stream_event chunks from cache — the assistant message contains
          // the final content, so streaming deltas are redundant for replay.
          if (message.type === "assistant") {
            this.pruneSdkMessages(session.messageCache, "stream_event");
          }

          // When a tool_result arrives, remove preceding tool_progress
          // events — they are transient progress indicators.
          if (
            message.type === "user" &&
            (message as SDKUserMessage).tool_use_result !== undefined
          ) {
            this.pruneSdkMessages(session.messageCache, "tool_progress");
          }

          // When a task_notification arrives, prune preceding task_progress
          // events for the same task_id — they are superseded by the final notification.
          if (
            message.type === "system" &&
            "subtype" in message &&
            message.subtype === "task_notification"
          ) {
            const taskId = (message as { task_id: string }).task_id;
            this.pruneSdkMessagesByPredicate(session.messageCache, (entry) => {
              if (sdkMessageKind(entry) !== "task_progress") return false;
              return (
                ((entry as WSSdkMessage).message as { task_id: string })
                  .task_id === taskId
              );
            });
          }

          this.broadcast(session, wrapped);
        }

        // Extract TodoWrite calls from assistant messages.
        // canUseTool is never called for TodoWrite (SDK auto-allows it),
        // so we detect it from the finalized assistant message content blocks.
        if (message.type === "assistant") {
          const todos = extractTodosFromAssistant(message);
          if (todos) {
            session.currentTodos = todos;
            const todoMsg = controlMsg({ type: "todo_update", todos });
            session.messageCache.push(todoMsg);
            this.broadcast(session, todoMsg);
          }
        }

        // result means this turn is done → IDLE
        if (message.type === "result") {
          session.state = "idle";
          session.lastActivityAt = Date.now();
          this.emit("session_state", {
            sessionId: session.sessionId,
            state: "idle" as SessionState,
          });
          // Don't break — generator stays alive, waiting for next message from queue
        }
      }
    } catch (err) {
      this.broadcast(
        session,
        controlMsg({
          type: "error",
          error: err instanceof Error ? err.message : "Unknown error",
          code: "QUERY_ERROR",
        }),
      );
    }

    // Generator exited → process terminated
    this.activeSessions.delete(session.sessionId);
    this.emit("session_state", {
      sessionId: session.sessionId,
      state: "inactive" as SessionState,
    });
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
      this.stopSession(id),
    );
    await Promise.all(stops);
  }
}

/** Check if a user message contains tool_result content blocks. */
function isToolResultMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const msg = message as Record<string, unknown>;
  if (!Array.isArray(msg.content)) return false;
  return (msg.content as Array<Record<string, unknown>>).some(
    (b) => b.type === "tool_result",
  );
}

/** Extract plain text from a user message. */
function extractUserText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const msg = message as Record<string, unknown>;
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return (msg.content as Array<Record<string, unknown>>)
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");
  }
  return "";
}

/**
 * Extract TodoWrite todos from an assistant SDK message.
 * Returns the todos array if a TodoWrite tool_use block is found, null otherwise.
 */
function extractTodosFromAssistant(message: SDKMessage): TodoItem[] | null {
  const msg = (message as SDKAssistantMessage).message as
    | Record<string, unknown>
    | undefined;
  if (!msg || !Array.isArray(msg.content)) return null;

  for (const block of msg.content as Array<Record<string, unknown>>) {
    if (block.type === "tool_use" && block.name === "TodoWrite") {
      const input = block.input as Record<string, unknown> | undefined;
      if (input && Array.isArray(input.todos)) {
        return input.todos as TodoItem[];
      }
    }
  }
  return null;
}
