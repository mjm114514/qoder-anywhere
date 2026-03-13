/**
 * AcpTranslator — stateful translator from ACP SessionUpdate notifications
 * to the existing WSServerMessage format used by the frontend.
 *
 * Maintains state for:
 *  - pendingText: accumulates agent_message_chunk text
 *  - activeToolCalls: tracks tool call lifecycle
 *  - messageCounter: generates unique UUIDs
 *
 * The translator emits WSServerMessage objects via a callback, preserving
 * the exact format the frontend useSessionSocket hook expects.
 */

import { randomUUID } from "node:crypto";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import type {
  WSServerMessage,
  WSSdkMessage,
  WSControlMessage,
  ControlPayload,
  TodoItem,
  WsAssistantMessage,
  WsStreamEvent,
  WsUserMessage,
  WsToolProgress,
  WsResultMessage,
} from "@lgtm-anywhere/shared";

// ── ACP SessionUpdate sub-types (from @agentclientprotocol/sdk) ──

interface AcpContentChunk {
  content: {
    type: string;
    text?: string;
    [key: string]: unknown;
  };
  messageId?: string | null;
}

interface AcpToolCall {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: string;
  content?: Array<{
    type: string;
    text?: string;
    [key: string]: unknown;
  }>;
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: Array<{ path?: string; [key: string]: unknown }>;
}

interface AcpToolCallUpdate {
  toolCallId: string;
  title?: string | null;
  kind?: string | null;
  status?: string | null;
  content?: Array<{
    type: string;
    text?: string;
    [key: string]: unknown;
  }> | null;
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: Array<{ path?: string; [key: string]: unknown }> | null;
}

interface AcpCurrentModeUpdate {
  mode: string;
  availableModes?: Array<{
    slug: string;
    name: string;
    description?: string;
  }>;
}

// ── Internal tool call tracking ──

interface TrackedToolCall {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  status: string;
}

// ── Envelope helpers ──

function sdkMsg(message: WSSdkMessage["message"]): WSSdkMessage {
  return { category: "sdk", message };
}

function controlMsg(message: ControlPayload): WSControlMessage {
  return { category: "control", message };
}

// ── Permission mode mapping ──

/** Map ACP session mode slugs to our PermissionMode type. */
function mapModeToPermissionMode(
  mode: string,
): "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | null {
  switch (mode) {
    case "code":
    case "default":
      return "default";
    case "acceptEdits":
    case "accept-edits":
      return "acceptEdits";
    case "bypass":
    case "bypassPermissions":
    case "trust":
      return "bypassPermissions";
    case "plan":
    case "architect":
      return "plan";
    case "dontAsk":
      return "dontAsk";
    default:
      return null;
  }
}

export class AcpTranslator {
  /** Accumulated text chunks that haven't been flushed as a full assistant message yet. */
  private pendingText = "";
  /** Tracks active tool calls by toolCallId. */
  private activeToolCalls = new Map<string, TrackedToolCall>();
  /** Session ID for tagging messages. */
  private sessionId: string;
  /** Callback to emit translated WSServerMessage. */
  private emit: (msg: WSServerMessage) => void;
  /** Counter for generating unique message IDs. */
  private currentMessageId: string | null = null;

  constructor(sessionId: string, emit: (msg: WSServerMessage) => void) {
    this.sessionId = sessionId;
    this.emit = emit;
  }

  /**
   * Process an ACP SessionNotification and emit zero or more WSServerMessages.
   */
  handleSessionUpdate(notification: SessionNotification): void {
    const update = notification.update as Record<string, unknown>;
    const updateType = update.sessionUpdate as string;

    switch (updateType) {
      case "agent_message_chunk":
        this.handleAgentMessageChunk(update as unknown as AcpContentChunk);
        break;

      case "user_message_chunk":
        // User messages are handled directly by the server (session_message),
        // we don't expect the agent to echo them back. Ignore.
        break;

      case "agent_thought_chunk":
        // Thoughts are internal — ignore for now
        break;

      case "tool_call":
        this.handleToolCall(update as unknown as AcpToolCall);
        break;

      case "tool_call_update":
        this.handleToolCallUpdate(update as unknown as AcpToolCallUpdate);
        break;

      case "current_mode_update":
        this.handleCurrentModeUpdate(update as unknown as AcpCurrentModeUpdate);
        break;

      case "plan":
      case "available_commands_update":
      case "config_option_update":
      case "session_info_update":
        // Ignored or custom handling later
        break;

      default:
        // Unknown update type — ignore
        break;
    }
  }

  /**
   * Called when the prompt() call completes (agent turn ends).
   * Flushes any remaining text and emits a result message.
   */
  handlePromptComplete(stopReason: string): void {
    // Flush any remaining text as a finalized assistant message
    this.flushPendingText();

    // Emit a "result" SDK message
    const resultMsg: WsResultMessage = {
      type: "result",
      result: { stopReason },
      session_id: this.sessionId,
    };
    this.emit(sdkMsg(resultMsg));
  }

  /**
   * Reset translator state (e.g., when session changes).
   */
  reset(): void {
    this.pendingText = "";
    this.activeToolCalls.clear();
    this.currentMessageId = null;
  }

  // ── Private handlers ──

  private handleAgentMessageChunk(chunk: AcpContentChunk): void {
    if (chunk.content?.type !== "text" || !chunk.content.text) return;

    this.pendingText += chunk.content.text;

    // Track message ID for grouping chunks into one assistant message
    if (chunk.messageId && !this.currentMessageId) {
      this.currentMessageId = chunk.messageId;
    }

    // Emit a stream_event delta so the frontend shows streaming text
    const streamEvent: WsStreamEvent = {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: {
          type: "text_delta",
          text: chunk.content.text,
        },
      },
      parent_tool_use_id: null,
    };
    this.emit(sdkMsg(streamEvent));
  }

  private handleToolCall(toolCall: AcpToolCall): void {
    // When a new tool call arrives, flush any pending text as a finalized
    // assistant message (with the tool_use block appended).
    const toolName = toolCall.title ?? toolCall.kind ?? "unknown_tool";
    const toolInput = (toolCall.rawInput as Record<string, unknown>) ?? {};

    // Track this tool call
    this.activeToolCalls.set(toolCall.toolCallId, {
      toolCallId: toolCall.toolCallId,
      toolName,
      input: toolInput,
      status: toolCall.status ?? "in_progress",
    });

    // Flush pending text + add tool_use block
    const textBlocks: Array<Record<string, unknown>> = [];
    if (this.pendingText) {
      textBlocks.push({ type: "text", text: this.pendingText });
      this.pendingText = "";
    }
    textBlocks.push({
      type: "tool_use",
      id: toolCall.toolCallId,
      name: toolName,
      input: toolInput,
    });

    const assistantMsg: WsAssistantMessage = {
      type: "assistant",
      uuid: this.currentMessageId ?? randomUUID(),
      message: {
        role: "assistant",
        content: textBlocks,
      },
      parent_tool_use_id: null,
      session_id: this.sessionId,
    };
    this.emit(sdkMsg(assistantMsg));
    this.currentMessageId = null;
  }

  private handleToolCallUpdate(update: AcpToolCallUpdate): void {
    const tracked = this.activeToolCalls.get(update.toolCallId);
    if (!tracked) return;

    // Update tracked status
    if (update.status) {
      tracked.status = update.status;
    }

    if (update.status === "completed" || update.status === "failed") {
      // Extract result text
      let resultText = "";
      if (update.content && update.content.length > 0) {
        resultText = update.content
          .filter((c) => c.type === "text" && c.text)
          .map((c) => c.text!)
          .join("\n");
      }
      if (!resultText && update.rawOutput != null) {
        resultText =
          typeof update.rawOutput === "string"
            ? update.rawOutput
            : JSON.stringify(update.rawOutput);
      }

      // Check for TodoWrite tool — emit todo_update
      this.checkAndEmitTodoUpdate(tracked, update);

      // Emit as a user message with tool_result
      const userMsg: WsUserMessage = {
        type: "user",
        uuid: randomUUID(),
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: update.toolCallId,
              content: resultText,
              is_error: update.status === "failed",
            },
          ],
        },
        tool_use_result: true,
        parent_tool_use_id: null,
        session_id: this.sessionId,
      };
      this.emit(sdkMsg(userMsg));

      this.activeToolCalls.delete(update.toolCallId);
    } else if (update.status === "in_progress") {
      // Emit tool_progress for in-progress updates
      let progressText = "";
      if (update.content && update.content.length > 0) {
        progressText = update.content
          .filter((c) => c.type === "text" && c.text)
          .map((c) => c.text!)
          .join("\n");
      }
      if (progressText) {
        const progressMsg: WsToolProgress = {
          type: "tool_progress",
          tool_use_id: update.toolCallId,
          content: progressText,
        };
        this.emit(sdkMsg(progressMsg));
      }
    }
  }

  private handleCurrentModeUpdate(update: AcpCurrentModeUpdate): void {
    const mode = mapModeToPermissionMode(update.mode);
    if (mode) {
      this.emit(controlMsg({ type: "permission_mode_changed", mode }));
    }
  }

  /**
   * Flush accumulated text as a finalized assistant message.
   */
  private flushPendingText(): void {
    if (!this.pendingText) return;

    const assistantMsg: WsAssistantMessage = {
      type: "assistant",
      uuid: this.currentMessageId ?? randomUUID(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: this.pendingText }],
      },
      parent_tool_use_id: null,
      session_id: this.sessionId,
    };
    this.emit(sdkMsg(assistantMsg));

    this.pendingText = "";
    this.currentMessageId = null;
  }

  /**
   * Check if a completed tool call is TodoWrite and emit todo_update.
   */
  private checkAndEmitTodoUpdate(
    tracked: TrackedToolCall,
    update: AcpToolCallUpdate,
  ): void {
    if (tracked.toolName !== "TodoWrite") return;

    // Try to extract todos from the tool input
    const input = update.rawInput ?? tracked.input;
    if (input && typeof input === "object") {
      const inp = input as Record<string, unknown>;
      if (Array.isArray(inp.todos)) {
        this.emit(
          controlMsg({ type: "todo_update", todos: inp.todos as TodoItem[] }),
        );
      }
    }
  }
}
