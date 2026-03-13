/**
 * ProcessTransport — spawns qodercli with stdio NDJSON protocol.
 *
 * Always uses streaming mode (matching @anthropic-ai/claude-agent-sdk):
 *   `--input-format stream-json --output-format stream-json`
 *
 * All prompts (string or multi-turn) are sent via stdin as NDJSON user messages.
 * This is the same approach as the Claude Agent SDK, which never uses `--print`.
 *
 * Handles:
 * - Spawning the qodercli subprocess
 * - Writing NDJSON messages to stdin
 * - Reading NDJSON messages from stdout via readline
 * - Detecting conversation completion via `type: "result"` messages
 * - Environment variable injection (QODER_ENTRYPOINT=sdk-ts)
 * - Process lifecycle (kill, signal)
 * - Permission control protocol (can_use_tool requests/responses)
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
  createInterface,
  type Interface as ReadlineInterface,
} from "node:readline";
import type {
  QoderMessage,
  QoderControlRequest,
  QoderControlResponse,
  QoderControlResponseFromCli,
  QueryOptions,
  CanUseToolOptions,
} from "./types.js";
import { parseJsonLine } from "./utils.js";

export class ProcessTransport {
  private process: ChildProcess | null = null;
  private readline: ReadlineInterface | null = null;
  private stderrChunks: string[] = [];
  /** Pending control requests awaiting a control_response from qodercli. */
  private pendingControlRequests = new Map<
    string,
    { resolve: () => void; reject: (err: Error) => void }
  >();
  /** Counter for generating unique control request IDs. */
  private controlRequestCounter = 0;
  /** Abort controller for the current session (used in canUseTool options). */
  private abortController: AbortController;

  constructor(private readonly options: QueryOptions = {}) {
    this.abortController = options.abortController ?? new AbortController();
  }

  /**
   * Build the argument array for the qodercli command.
   *
   * Always uses streaming mode: --input-format stream-json --output-format stream-json
   * The prompt is sent via stdin, not CLI flags.
   *
   * Note: --max-turns is NOT passed because it only works with --print mode
   * in qodercli, not with streaming mode. The SDK tracks turns internally.
   */
  buildArgs(): string[] {
    const args: string[] = [];
    const opts = this.options;

    // Always streaming mode — prompt is sent via stdin as NDJSON
    args.push("--input-format", "stream-json");
    args.push("--output-format", "stream-json");
    args.push("--quiet");

    // NOTE: --max-turns is intentionally NOT passed here.
    // It only works with --print mode in qodercli, not with streaming mode.
    // The SDK can track turns internally if maxTurns is set.

    // --workspace
    if (opts.cwd) {
      args.push("--workspace", opts.cwd);
    }

    // --model
    if (opts.model) {
      args.push("--model", opts.model);
    }

    // --dangerously-skip-permissions / --yolo
    if (
      opts.permissionMode === "yolo" ||
      opts.permissionMode === "bypassPermissions" ||
      opts.allowDangerouslySkipPermissions
    ) {
      args.push("--dangerously-skip-permissions");
    }

    // --resume
    if (opts.resume) {
      args.push("--resume", opts.resume);
    }

    // --continue
    if (opts.continue) {
      args.push("--continue");
    }

    // --allowed-tools
    if (opts.allowedTools && opts.allowedTools.length > 0) {
      args.push("--allowed-tools", opts.allowedTools.join(","));
    }

    // --disallowed-tools
    if (opts.disallowedTools && opts.disallowedTools.length > 0) {
      args.push("--disallowed-tools", opts.disallowedTools.join(","));
    }

    // --include-partial-messages
    if (opts.includePartialMessages) {
      args.push("--include-partial-messages");
    }

    // --max-output-tokens
    if (opts.maxOutputTokens) {
      args.push("--max-output-tokens", opts.maxOutputTokens);
    }

    // --agents (JSON string)
    if (opts.agents && Object.keys(opts.agents).length > 0) {
      args.push("--agents", JSON.stringify(opts.agents));
    }

    // --attachment (repeatable flag)
    if (opts.attachments && opts.attachments.length > 0) {
      for (const attachment of opts.attachments) {
        args.push("--attachment", attachment);
      }
    }

    // --with-claude-config
    if (opts.withClaudeConfig) {
      args.push("--with-claude-config");
    }

    // --system-prompt
    if (opts.systemPrompt) {
      args.push("--system-prompt", opts.systemPrompt);
    }

    return args;
  }

  /**
   * Spawn the qodercli process and set up stdio pipes.
   *
   * Environment handling (mirrors @anthropic-ai/claude-agent-sdk):
   *   1. Start with options.env if provided, otherwise spread process.env
   *   2. Auto-inject QODER_ENTRYPOINT=sdk-ts (tells qodercli it's in SDK/stdio mode)
   *   3. Remove NODE_OPTIONS to prevent flag inheritance issues
   */
  start(): void {
    const bin = this.options.pathToQodercli ?? "qodercli";
    const args = this.buildArgs();

    // Build env: user-provided env replaces process.env entirely (same as Claude SDK)
    const env: Record<string, string | undefined> = {
      ...(this.options.env ?? process.env),
    };

    // Auto-inject QODER_ENTRYPOINT to signal SDK/stdio mode (critical for non-TTY operation)
    if (!env.QODER_ENTRYPOINT) {
      env.QODER_ENTRYPOINT = "sdk-ts";
    }

    // Remove NODE_OPTIONS to prevent Node.js flag inheritance issues
    delete env.NODE_OPTIONS;

    this.process = spawn(bin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: env as NodeJS.ProcessEnv,
      // If no explicit cwd in options, let the process inherit
      ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
    });

    // Collect stderr for debugging
    this.process.stderr?.on("data", (chunk: Buffer) => {
      this.stderrChunks.push(chunk.toString());
    });

    // Set up readline on stdout for NDJSON parsing
    if (this.process.stdout) {
      this.readline = createInterface({
        input: this.process.stdout,
        crlfDelay: Infinity,
      });
    }
  }

  /**
   * Write a JSON message to qodercli's stdin as a single NDJSON line.
   */
  write(message: unknown): void {
    if (!this.process?.stdin?.writable) {
      throw new Error("Process stdin is not writable");
    }
    const line = JSON.stringify(message) + "\n";
    this.process.stdin.write(line);
  }

  /**
   * Close stdin (signals no more input to qodercli).
   */
  closeStdin(): void {
    this.process?.stdin?.end();
  }

  /**
   * Async generator that yields parsed QoderMessage objects from stdout.
   *
   * Internally intercepts:
   * - `control_request` messages (e.g. `can_use_tool` permission checks):
   *   Handles them via the `canUseTool` callback, sending a `control_response`
   *   back to stdin. These are never yielded to the consumer.
   * - `control_response` messages from qodercli (e.g. ack of initialize):
   *   These are internal protocol messages and are never yielded to the consumer.
   *
   * Completes when the readline interface closes (process exits or stdout ends).
   */
  async *readMessages(): AsyncGenerator<QoderMessage, void, undefined> {
    if (!this.readline) {
      throw new Error("Transport not started — call start() first");
    }

    const rl = this.readline;
    const canUseTool = this.options.canUseTool;

    // Wrap readline as an async iterator
    for await (const line of rl) {
      const parsed = parseJsonLine<
        QoderMessage | QoderControlRequest | QoderControlResponseFromCli
      >(line);
      if (parsed === null) continue;

      // Intercept control_request messages (permission checks from qodercli)
      if (parsed.type === "control_request") {
        const req = parsed as QoderControlRequest;
        if (req.request.subtype === "can_use_tool") {
          await this.handleCanUseTool(req, canUseTool);
        }
        // Do NOT yield control_request to the consumer
        continue;
      }

      // Intercept control_response messages from qodercli (e.g. ack of initialize/interrupt)
      if (parsed.type === "control_response") {
        // Check if this is a response to a pending control request (setModel, setPermissionMode, etc.)
        const resp = parsed as QoderControlResponseFromCli;
        const requestId = resp.response?.request_id;
        if (requestId && this.pendingControlRequests.has(requestId)) {
          const pending = this.pendingControlRequests.get(requestId)!;
          this.pendingControlRequests.delete(requestId);
          if (resp.response.subtype === "success") {
            pending.resolve();
          } else {
            pending.reject(
              new Error(
                `Control request ${requestId} failed: ${JSON.stringify(resp.response)}`,
              ),
            );
          }
        }
        // Internal protocol message — do NOT yield to consumer
        continue;
      }

      yield parsed as QoderMessage;
    }
  }

  /**
   * Handle a `can_use_tool` control request from qodercli.
   *
   * If a `canUseTool` callback is provided, calls it with (toolName, input, options)
   * and sends the result. Otherwise, auto-allows the tool (default permissive behavior).
   */
  private async handleCanUseTool(
    req: QoderControlRequest,
    canUseTool: QueryOptions["canUseTool"],
  ): Promise<void> {
    let result: import("./types.js").PermissionResult;

    if (canUseTool) {
      // Build the options object matching the Claude Agent SDK shape
      const options: CanUseToolOptions = {
        signal: this.abortController.signal,
        toolUseID: req.request_id,
      };
      try {
        result = await canUseTool(
          req.request.tool_name,
          req.request.input,
          options,
        );
      } catch (err) {
        // If the callback throws, deny with the error message
        result = {
          behavior: "deny",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    } else {
      // No callback → auto-allow (matches default SDK behavior when permissionMode is yolo)
      result = { behavior: "allow" };
    }

    const response: QoderControlResponse = {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: req.request_id,
        response: result,
      },
    };

    this.write(response);
  }

  /**
   * Send SIGTERM to kill the subprocess.
   */
  kill(): void {
    if (this.process && !this.process.killed) {
      this.process.kill("SIGTERM");
    }
  }

  /**
   * Send SIGINT to interrupt the current operation.
   *
   * Note: Probe testing confirmed that SIGINT works as a fallback for
   * interrupting the qodercli process. The control_request protocol
   * for interrupt is also available but SIGINT is simpler and reliable.
   */
  interrupt(): void {
    if (this.process && !this.process.killed) {
      this.process.kill("SIGINT");
    }
  }

  /**
   * Send a control_request to qodercli and wait for the matching control_response.
   *
   * Used by setModel() and setPermissionMode() to send commands to the running
   * qodercli process via the stdin control protocol.
   *
   * @param subtype - The control request subtype (e.g. "set_model", "set_permission_mode")
   * @param payload - Additional fields to merge into the request object
   * @returns Promise that resolves when qodercli acknowledges the request
   */
  sendControlRequest(
    subtype: string,
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    const requestId = `sdk-ctrl-${++this.controlRequestCounter}-${Date.now()}`;

    const message = {
      type: "control_request",
      request_id: requestId,
      request: {
        subtype,
        ...payload,
      },
    };

    return new Promise<void>((resolve, reject) => {
      this.pendingControlRequests.set(requestId, { resolve, reject });
      try {
        this.write(message);
      } catch (err) {
        this.pendingControlRequests.delete(requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Get the process exit code (or null if still running).
   */
  get exitCode(): number | null {
    return this.process?.exitCode ?? null;
  }

  /**
   * Get collected stderr output (useful for debugging).
   */
  get stderr(): string {
    return this.stderrChunks.join("");
  }

  /**
   * Wait for the process to exit.
   */
  waitForExit(): Promise<number | null> {
    return new Promise((resolve) => {
      if (!this.process) {
        resolve(null);
        return;
      }
      if (this.process.exitCode !== null) {
        resolve(this.process.exitCode);
        return;
      }
      this.process.on("exit", (code) => {
        resolve(code);
      });
    });
  }
}
