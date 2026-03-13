/**
 * AcpConnection — wraps a single ACP agent subprocess + ClientSideConnection.
 *
 * Responsibilities:
 *  - Spawn agent subprocess (command configurable), establish NDJSON stream
 *  - Implement ACP Client interface (sessionUpdate → callback, requestPermission → callback)
 *  - Expose methods: initialize(), newSession(), loadSession(), listSessions(),
 *    prompt(), cancel(), setSessionMode(), unstable_setSessionModel()
 *  - Manage process lifecycle (exit listening, kill, cleanup)
 */

import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type {
  SessionNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
  AuthenticateRequest,
  AuthenticateResponse,
} from "@agentclientprotocol/sdk";

export interface AcpConnectionOptions {
  /** The command to spawn (e.g. "claude"). */
  command: string;
  /** Arguments for the command (e.g. ["--acp"]). */
  args?: string[];
  /** Callback for SessionUpdate notifications. */
  onSessionUpdate: (notification: SessionNotification) => void;
  /** Callback for requestPermission requests. */
  onRequestPermission: (
    params: RequestPermissionRequest,
  ) => Promise<RequestPermissionResponse>;
  /** Called when the subprocess exits. */
  onProcessExit?: (code: number | null, signal: string | null) => void;
}

/**
 * The ACP Client implementation that receives calls from the agent.
 */
class AcpClient implements acp.Client {
  constructor(
    private readonly onSessionUpdate: (
      notification: SessionNotification,
    ) => void,
    private readonly onRequestPermission: (
      params: RequestPermissionRequest,
    ) => Promise<RequestPermissionResponse>,
  ) {}

  async sessionUpdate(params: SessionNotification): Promise<void> {
    this.onSessionUpdate(params);
  }

  async requestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    return this.onRequestPermission(params);
  }

  async authenticate(
    _params: AuthenticateRequest,
  ): Promise<AuthenticateResponse | void> {
    // No authentication needed for local subprocess
    return;
  }
}

export class AcpConnection {
  private process: ChildProcess | null = null;
  private connection: acp.ClientSideConnection | null = null;
  private client: AcpClient;
  private readonly options: AcpConnectionOptions;

  constructor(options: AcpConnectionOptions) {
    this.options = options;
    this.client = new AcpClient(
      options.onSessionUpdate,
      options.onRequestPermission,
    );
  }

  /**
   * Spawn the agent subprocess and establish the NDJSON connection.
   * Must be called before any other method.
   */
  async start(): Promise<void> {
    const { command, args = [] } = this.options;

    this.process = spawn(command, args, {
      stdio: ["pipe", "pipe", "inherit"],
    });

    this.process.on("exit", (code, signal) => {
      this.options.onProcessExit?.(code, signal);
    });

    this.process.on("error", (err) => {
      console.error("[AcpConnection] Process error:", err.message);
    });

    const input = Writable.toWeb(
      this.process.stdin!,
    ) as WritableStream<Uint8Array>;
    const output = Readable.toWeb(
      this.process.stdout!,
    ) as ReadableStream<Uint8Array>;

    const stream = acp.ndJsonStream(input, output);

    this.connection = new acp.ClientSideConnection(
      (_agent) => this.client,
      stream,
    );
  }

  /**
   * Initialize the ACP protocol handshake.
   */
  async initialize(): Promise<acp.InitializeResponse> {
    this.ensureConnection();
    return this.connection!.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
  }

  /**
   * Create a new session.
   */
  async newSession(params: { cwd?: string }): Promise<acp.NewSessionResponse> {
    this.ensureConnection();
    return this.connection!.newSession({
      cwd: params.cwd,
      mcpServers: [],
    });
  }

  /**
   * Load a previously saved session (replays history via sessionUpdate callbacks).
   */
  async loadSession(params: {
    sessionId: string;
    cwd?: string;
  }): Promise<acp.LoadSessionResponse> {
    this.ensureConnection();
    return this.connection!.loadSession!(params);
  }

  /**
   * List available sessions.
   */
  async listSessions(params?: {
    cwd?: string;
  }): Promise<acp.ListSessionsResponse> {
    this.ensureConnection();
    return this.connection!.listSessions!(params ?? {});
  }

  /**
   * Send a prompt to the agent. Returns when the agent's turn is complete.
   * SessionUpdate notifications arrive via the onSessionUpdate callback
   * while this promise is pending.
   */
  async prompt(params: {
    sessionId: string;
    prompt: string;
  }): Promise<acp.PromptResponse> {
    this.ensureConnection();
    return this.connection!.prompt({
      sessionId: params.sessionId,
      prompt: [{ type: "text", text: params.prompt }],
    });
  }

  /**
   * Cancel the current prompt turn.
   */
  async cancel(params: { sessionId: string }): Promise<void> {
    this.ensureConnection();
    return this.connection!.cancel({ sessionId: params.sessionId });
  }

  /**
   * Set the session operating mode (e.g., "ask", "code", "architect").
   */
  async setSessionMode(params: {
    sessionId: string;
    mode: string;
  }): Promise<void> {
    this.ensureConnection();
    await this.connection!.setSessionMode!({
      sessionId: params.sessionId,
      mode: params.mode,
    });
  }

  /**
   * Set the model for a session (experimental).
   */
  async setSessionModel(params: {
    sessionId: string;
    model: string;
  }): Promise<void> {
    this.ensureConnection();
    await this.connection!.unstable_setSessionModel!({
      sessionId: params.sessionId,
      model: params.model,
    });
  }

  /**
   * Kill the agent subprocess and clean up.
   */
  async close(): Promise<void> {
    if (this.process && !this.process.killed) {
      this.process.kill("SIGTERM");
      // Give it a moment, then force kill
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill("SIGKILL");
        }
      }, 3000);
    }
    this.process = null;
    this.connection = null;
  }

  /** Whether the subprocess is still alive. */
  get isAlive(): boolean {
    return this.process !== null && !this.process.killed;
  }

  private ensureConnection(): void {
    if (!this.connection) {
      throw new Error("AcpConnection not started — call start() first");
    }
  }
}
