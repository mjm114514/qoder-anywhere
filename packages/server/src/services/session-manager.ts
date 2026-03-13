import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type WebSocket from "ws";
import type {
  SessionState,
  TodoItem,
  UserImageAttachment,
  WSServerMessage,
  WSControlMessage,
  ControlPayload,
  WsAgentMessage,
  PermissionMode,
} from "@lgtm-anywhere/shared";
import type {
  SessionNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
  PromptResponse,
} from "@agentclientprotocol/sdk";
import { config } from "../config.js";
import { AcpConnection } from "./acp-connection.js";
import { AcpTranslator } from "./acp-translator.js";
import {
  listSessionsFromDisk,
  type DiskSessionInfo,
} from "./session-disk-reader.js";

// ── Envelope helpers ──

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

export interface ActiveSession {
  sessionId: string;
  cwd: string;
  connection: AcpConnection;
  translator: AcpTranslator;
  state: "active" | "idle";
  model?: string;
  createdAt: number;
  lastActivityAt: number;
  wsClients: Set<WebSocket>;
  /** Resolves with the sessionId once the ACP newSession responds */
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
  /** Pending tool approval requests awaiting user decision */
  pendingToolApprovals: Map<
    string,
    {
      toolName: string;
      input: Record<string, unknown>;
      resolve: (decision: { allow: boolean; denyMessage?: string }) => void;
    }
  >;
  /** Current permission mode for this session */
  permissionMode: PermissionMode;
  /** Full cache of WS messages (history + runtime) for the session lifetime */
  messageCache: WSServerMessage[];
  /** Current todo list maintained via TodoWrite tool interceptions */
  currentTodos: TodoItem[];
  /** In-flight prompt promise (null when idle) */
  promptInFlight: Promise<PromptResponse> | null;
  /** Available session modes from newSession response */
  availableModes?: Array<{ slug: string; name: string; description?: string }>;
}

export interface CreateSessionOptions {
  message: string;
  model?: string;
  permissionMode?: string;
  allowedTools?: string[];
  systemPrompt?: string;
  maxTurns?: number;
  images?: UserImageAttachment[];
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

  /** Return all in-memory active sessions (for sync snapshot). */
  getAllActiveSessions(): Array<{ sessionId: string; cwd: string }> {
    return Array.from(this.activeSessions.values()).map((s) => ({
      sessionId: s.sessionId,
      cwd: s.cwd,
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
    const { sessionIdReady, resolveSessionId } = makeSessionIdHook();

    const permMode: PermissionMode =
      (options.permissionMode as PermissionMode) ?? "bypassPermissions";

    // Create a placeholder session (connection/translator set below)
    const session: ActiveSession = {
      sessionId: "",
      cwd,
      connection: null as unknown as AcpConnection,
      translator: null as unknown as AcpTranslator,
      state: "active",
      model: options.model,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      wsClients: new Set(),
      sessionIdReady,
      resolveSessionId,
      pendingQuestions: new Map(),
      pendingToolApprovals: new Map(),
      permissionMode: permMode,
      messageCache: [],
      currentTodos: [],
      promptInFlight: null,
    };

    // Create ACP connection with callbacks
    const connection = this.createAcpConnection(session);
    session.connection = connection;

    console.log("[ACP] Starting agent subprocess...");
    await connection.start();
    await connection.initialize();
    console.log("[ACP] Agent initialized");

    // Create a new session via ACP
    const newSessionResult = await connection.newSession({ cwd });
    const acpSessionId = newSessionResult.sessionId;
    session.sessionId = acpSessionId;

    // Store available modes if returned (may be present as an extension field)
    const resultExt = newSessionResult as Record<string, unknown>;
    if (resultExt.availableModes && Array.isArray(resultExt.availableModes)) {
      session.availableModes =
        resultExt.availableModes as ActiveSession["availableModes"];
    }

    // Create translator now that we have the sessionId
    session.translator = new AcpTranslator(acpSessionId, (msg) =>
      this.handleTranslatorMessage(session, msg),
    );

    // Register session
    this.activeSessions.set(acpSessionId, session);
    resolveSessionId(acpSessionId);
    this.emit("session_state", {
      sessionId: acpSessionId,
      state: "active" as SessionState,
    });
    this.emit("session_created", {
      sessionId: acpSessionId,
      cwd: session.cwd,
    });

    // Cache the first user message
    session.messageCache.push(
      controlMsg({
        type: "session_message",
        message: options.message,
        ...(options.images?.length ? { images: options.images } : {}),
      }),
    );

    // Send the first prompt (don't await — runs in background)
    this.runPrompt(session, options.message);

    console.log(`[ACP] Session created: ${acpSessionId}`);
    return session;
  }

  async sendMessage(
    sessionId: string,
    message: string,
    cwd: string,
    images?: UserImageAttachment[],
  ): Promise<ActiveSession> {
    let session = this.activeSessions.get(sessionId);

    if (!session) {
      // Reactivate: create new connection, load session, then send
      session = await this.reactivateSession(sessionId, cwd, message, images);
    } else {
      // Session already active/idle — send prompt directly
      this.runPrompt(session, message);
    }

    // Cache and broadcast the user message
    const pending = controlMsg({
      type: "session_message",
      message,
      ...(images?.length ? { images } : {}),
    });
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
    _images?: UserImageAttachment[],
  ): Promise<ActiveSession> {
    const { sessionIdReady, resolveSessionId } = makeSessionIdHook();
    resolveSessionId(sessionId);

    const session: ActiveSession = {
      sessionId,
      cwd,
      connection: null as unknown as AcpConnection,
      translator: null as unknown as AcpTranslator,
      state: "active",
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      wsClients: new Set(),
      sessionIdReady,
      resolveSessionId,
      pendingQuestions: new Map(),
      pendingToolApprovals: new Map(),
      permissionMode: "bypassPermissions",
      messageCache: [],
      currentTodos: [],
      promptInFlight: null,
    };

    // Create ACP connection
    const connection = this.createAcpConnection(session);
    session.connection = connection;

    await connection.start();
    await connection.initialize();

    // Create translator
    session.translator = new AcpTranslator(sessionId, (msg) =>
      this.handleTranslatorMessage(session, msg),
    );

    this.activeSessions.set(sessionId, session);
    this.emit("session_state", { sessionId, state: "active" as SessionState });

    // Load session history via ACP — history replays through sessionUpdate callbacks
    try {
      await connection.loadSession({ sessionId, cwd });
    } catch (err) {
      console.error("[ACP] Failed to load session:", err);
    }

    // The translator will have emitted history messages via sessionUpdate.
    // Now send the new message.
    this.runPrompt(session, firstMessage);

    return session;
  }

  /**
   * List sessions by reading directly from disk (~/.qoder/projects/).
   * No ACP subprocess needed.
   */
  async listSessions(params?: { cwd?: string }): Promise<DiskSessionInfo[]> {
    return listSessionsFromDisk(params);
  }

  /**
   * Load session history via ACP and convert to WSServerMessages for replay.
   * Creates a temporary connection to load the session.
   */
  async convertHistoryToWSEvents(
    sessionId: string,
  ): Promise<WSServerMessage[]> {
    const events: WSServerMessage[] = [];

    // Create a temporary translator that collects messages into events
    const translator = new AcpTranslator(sessionId, (msg) => {
      events.push(msg);
    });

    // Create a temporary connection
    const tempConnection = new AcpConnection({
      command: config.agentCommand,
      args: config.agentArgs,
      onSessionUpdate: (notification) => {
        translator.handleSessionUpdate(notification);
      },
      onRequestPermission: async () => ({
        outcome: { outcome: "cancelled" as const },
      }),
    });

    try {
      await tempConnection.start();
      await tempConnection.initialize();
      await tempConnection.loadSession({ sessionId });
    } catch (err) {
      console.error("[ACP] Failed to load session history:", err);
    } finally {
      await tempConnection.close();
    }

    return events;
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

    // Deny all pending tool approvals so Promises don't hang
    for (const [, pending] of session.pendingToolApprovals) {
      pending.resolve({
        allow: false,
        denyMessage: "Session stopped",
      });
    }
    session.pendingToolApprovals.clear();

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

    // Cancel any in-flight prompt and close the connection
    try {
      await session.connection.cancel({ sessionId });
    } catch {
      // Ignore — process might already be dead
    }
    await session.connection.close();

    this.activeSessions.delete(sessionId);
    this.emit("session_state", {
      sessionId,
      state: "inactive" as SessionState,
    });
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      await session.connection.setSessionModel({ sessionId, model });
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
   * Resolve a pending tool approval request with user decision.
   */
  resolveToolApproval(
    sessionId: string,
    requestId: string,
    decision: "allow" | "deny",
    denyMessage?: string,
  ): boolean {
    const session = this.activeSessions.get(sessionId);
    if (!session) return false;
    const pending = session.pendingToolApprovals.get(requestId);
    if (!pending) return false;
    pending.resolve({
      allow: decision === "allow",
      denyMessage,
    });
    session.pendingToolApprovals.delete(requestId);

    // Remove the cached approval request so it won't replay
    const idx = session.messageCache.findIndex(
      (entry) =>
        entry.category === "control" &&
        entry.message.type === "tool_approval_request" &&
        entry.message.requestId === requestId,
    );
    if (idx !== -1) session.messageCache.splice(idx, 1);

    return true;
  }

  /**
   * Change the permission mode for a session at runtime.
   * Uses ACP setSessionMode + broadcasts to clients.
   * When switching to bypassPermissions, auto-approves all pending tool approvals.
   */
  async setPermissionMode(
    sessionId: string,
    mode: PermissionMode,
  ): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    // Map our PermissionMode to ACP mode slug
    const acpMode = mapPermissionModeToAcpMode(mode);
    if (acpMode) {
      try {
        await session.connection.setSessionMode({ sessionId, mode: acpMode });
      } catch {
        // Agent may not support setSessionMode — fall through
      }
    }

    session.permissionMode = mode;

    // If switching to bypass mode, auto-approve all pending tool approvals
    if (mode === "bypassPermissions") {
      for (const [requestId, pending] of session.pendingToolApprovals) {
        pending.resolve({ allow: true });
        // Remove the cached approval request
        const idx = session.messageCache.findIndex(
          (entry) =>
            entry.category === "control" &&
            entry.message.type === "tool_approval_request" &&
            entry.message.requestId === requestId,
        );
        if (idx !== -1) session.messageCache.splice(idx, 1);
      }
      session.pendingToolApprovals.clear();
    }

    this.broadcast(
      session,
      controlMsg({ type: "permission_mode_changed", mode }),
    );
  }

  // ── Private: ACP connection factory ──

  private createAcpConnection(session: ActiveSession): AcpConnection {
    return new AcpConnection({
      command: config.agentCommand,
      args: config.agentArgs,
      onSessionUpdate: (notification: SessionNotification) => {
        // Route through translator if available
        if (session.translator) {
          session.translator.handleSessionUpdate(notification);
        }
      },
      onRequestPermission: (
        params: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> => {
        return this.handleRequestPermission(session, params);
      },
      onProcessExit: (code, signal) => {
        console.log(
          `[ACP] Process exited: code=${code}, signal=${signal}, session=${session.sessionId}`,
        );
        // Clean up the session
        if (this.activeSessions.has(session.sessionId)) {
          this.activeSessions.delete(session.sessionId);
          this.emit("session_state", {
            sessionId: session.sessionId,
            state: "inactive" as SessionState,
          });
        }
      },
    });
  }

  // ── Private: ACP requestPermission handler ──

  /**
   * Handle ACP requestPermission requests from the agent.
   * Maps ACP permission options to our existing tool approval / AskUserQuestion flow.
   */
  private handleRequestPermission(
    session: ActiveSession,
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const toolCall = params.toolCall as Record<string, unknown> | undefined;
    const toolCallId = toolCall?.toolCallId as string | undefined;
    const toolName = (toolCall?.title as string) ?? "unknown_tool";
    const rawInput = (toolCall?.rawInput as Record<string, unknown>) ?? {};
    const options = (params.options ?? []) as Array<{
      kind: string;
      name: string;
      optionId: string;
    }>;

    // bypassPermissions mode: auto-allow
    if (session.permissionMode === "bypassPermissions") {
      const allowOption = options.find(
        (o) => o.kind === "allow_once" || o.kind === "allow_always",
      );
      return Promise.resolve({
        outcome: {
          outcome: "selected" as const,
          optionId: allowOption?.optionId ?? options[0]?.optionId ?? "allow",
        },
      });
    }

    // Non-bypass mode: broadcast tool approval request and wait for user decision
    const requestId = randomUUID();

    // Cache & broadcast approval request
    const cached = controlMsg({
      type: "tool_approval_request",
      requestId,
      toolName,
      toolUseId: toolCallId ?? requestId,
      input: rawInput,
    });
    session.messageCache.push(cached);
    this.broadcast(session, cached);

    // Wait for user decision
    return new Promise<RequestPermissionResponse>((resolve) => {
      session.pendingToolApprovals.set(requestId, {
        toolName,
        input: rawInput,
        resolve: (decision: { allow: boolean; denyMessage?: string }) => {
          // Remove the cached approval request
          const approvalIdx = session.messageCache.indexOf(cached);
          if (approvalIdx !== -1) session.messageCache.splice(approvalIdx, 1);

          if (decision.allow) {
            const allowOption = options.find(
              (o) => o.kind === "allow_once" || o.kind === "allow_always",
            );
            resolve({
              outcome: {
                outcome: "selected" as const,
                optionId:
                  allowOption?.optionId ?? options[0]?.optionId ?? "allow",
              },
            });
          } else {
            const rejectOption = options.find(
              (o) => o.kind === "reject_once" || o.kind === "reject_always",
            );
            if (rejectOption) {
              resolve({
                outcome: {
                  outcome: "selected" as const,
                  optionId: rejectOption.optionId,
                },
              });
            } else {
              resolve({
                outcome: { outcome: "cancelled" as const },
              });
            }
          }
        },
      });
    });
  }

  // ── Private: prompt execution ──

  /**
   * Send a prompt to the ACP agent. Runs in the background.
   * When the prompt completes, transitions session to idle.
   */
  private runPrompt(session: ActiveSession, message: string): void {
    session.promptInFlight = session.connection
      .prompt({ sessionId: session.sessionId, prompt: message })
      .then((result) => {
        // Prompt completed — flush translator and transition to idle
        session.translator.handlePromptComplete(result.stopReason);

        session.state = "idle";
        session.lastActivityAt = Date.now();
        session.promptInFlight = null;
        this.emit("session_state", {
          sessionId: session.sessionId,
          state: "idle" as SessionState,
        });
        return result;
      })
      .catch((err) => {
        session.promptInFlight = null;
        this.broadcast(
          session,
          controlMsg({
            type: "error",
            error: err instanceof Error ? err.message : "Unknown error",
            code: "PROMPT_ERROR",
          }),
        );
        session.state = "idle";
        session.lastActivityAt = Date.now();
        this.emit("session_state", {
          sessionId: session.sessionId,
          state: "idle" as SessionState,
        });
        throw err;
      });
  }

  // ── Private: translator message handler ──

  /**
   * Called by the AcpTranslator for each translated WSServerMessage.
   * Caches and broadcasts the message to WS clients.
   */
  private handleTranslatorMessage(
    session: ActiveSession,
    msg: WSServerMessage,
  ): void {
    // Cache the message
    session.messageCache.push(msg);

    // Cache pruning: same logic as the old SDK-based approach
    if (msg.category === "sdk") {
      const kind = sdkMessageKind(msg);

      // When a complete assistant message arrives, prune stream_events
      if (kind === "assistant") {
        this.pruneSdkMessages(session.messageCache, "stream_event");
      }

      // When a tool_result arrives, prune tool_progress events
      if (msg.message.type === "user" && "tool_use_result" in msg.message) {
        this.pruneSdkMessages(session.messageCache, "tool_progress");
      }

      // Extract TodoWrite calls from assistant messages
      if (msg.message.type === "assistant") {
        const todos = extractTodosFromAssistant(msg.message);
        if (todos) {
          session.currentTodos = todos;
          const todoMsg = controlMsg({ type: "todo_update", todos });
          session.messageCache.push(todoMsg);
          this.broadcast(session, todoMsg);
        }
      }
    }

    // Broadcast to WS clients
    this.broadcast(session, msg);
  }

  // ── Private: WS helpers ──

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
   */
  private pruneSdkMessages(cache: WSServerMessage[], kind: string): void {
    for (let i = cache.length - 2; i >= 0; i--) {
      if (sdkMessageKind(cache[i]) === kind) {
        cache.splice(i, 1);
      }
    }
  }

  // ── Lifecycle ──

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

// ── Module-level helpers ──

/** Map our PermissionMode to ACP mode slug. */
function mapPermissionModeToAcpMode(mode: PermissionMode): string | null {
  switch (mode) {
    case "default":
      return "code";
    case "acceptEdits":
      return "acceptEdits";
    case "bypassPermissions":
      return "trust";
    case "plan":
      return "plan";
    case "dontAsk":
      return "dontAsk";
    default:
      return null;
  }
}

/**
 * Extract TodoWrite todos from a translated assistant WsAgentMessage.
 * Returns the todos array if a TodoWrite tool_use block is found, null otherwise.
 */
function extractTodosFromAssistant(message: WsAgentMessage): TodoItem[] | null {
  if (message.type !== "assistant") return null;
  const msg = message.message as Record<string, unknown> | undefined;
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
