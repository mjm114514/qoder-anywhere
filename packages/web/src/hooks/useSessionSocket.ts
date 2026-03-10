import { useState, useEffect, useRef, useCallback } from "react";
import type {
  WSServerMessage,
  ControlPayload,
  AskUserQuestionItem,
  TodoItem,
} from "@lgtm-anywhere/shared";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

// ── Subagent state ──

export interface SubagentState {
  taskId: string;
  toolUseId: string;
  description: string;
  prompt?: string;
  status: "running" | "completed" | "failed" | "stopped";
  summary?: string;
  result?: string;
  lastToolName?: string;
  usage?: {
    total_tokens: number;
    tool_uses: number;
    duration_ms: number;
  };
  innerBlocks: ContentBlock[];
}

// A single content block in an assistant turn
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; toolUseId: string; name: string; input?: unknown }
  | { type: "tool_result"; toolUseId: string; content: string }
  | { type: "subagent"; toolUseId: string; task: SubagentState };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string; // plain text (for user messages or backward compat)
  blocks: ContentBlock[]; // structured content blocks for assistant messages
  isStreaming?: boolean;
}

export interface PendingQuestion {
  requestId: string;
  questions: AskUserQuestionItem[];
}

interface UseSessionSocketReturn {
  messages: ChatMessage[];
  isStreaming: boolean;
  isLoadingHistory: boolean;
  error: string | null;
  pendingQuestion: PendingQuestion | null;
  todos: TodoItem[];
  sendMessage: (text: string) => void;
  answerQuestion: (requestId: string, answers: Record<string, string>) => void;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
}

export function useSessionSocket(
  sessionId: string | null,
): UseSessionSocketReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingQuestion, setPendingQuestion] =
    useState<PendingQuestion | null>(null);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const streamBufRef = useRef<{ id: string; text: string } | null>(null);
  const isLoadingHistoryRef = useRef(false);

  // Subagent tracking: maps toolUseId → SubagentState
  const subagentMapRef = useRef<Map<string, SubagentState>>(new Map());

  // Reset state when sessionId changes (render-phase reset to avoid cascading renders)
  const [prevSessionId, setPrevSessionId] = useState(sessionId);
  if (prevSessionId !== sessionId) {
    setPrevSessionId(sessionId);
    setPendingQuestion(null);
    setTodos([]);
    setMessages([]);
    setIsStreaming(false);
    setError(null);
  }

  // Reset ref outside of render to satisfy react-hooks/refs rule
  useEffect(() => {
    subagentMapRef.current = new Map();
  }, [sessionId]);

  /**
   * Trigger a React re-render for a specific subagent by creating a new
   * message reference for the message containing it.
   */
  const updateSubagentInMessages = useCallback((toolUseId: string) => {
    setMessages((prev) => {
      const subagent = subagentMapRef.current.get(toolUseId);
      if (!subagent) return prev;

      for (let i = prev.length - 1; i >= 0; i--) {
        const m = prev[i];
        if (m.role !== "assistant") continue;
        const blockIdx = m.blocks.findIndex(
          (b) => b.type === "subagent" && b.toolUseId === toolUseId,
        );
        if (blockIdx >= 0) {
          const next = [...prev];
          const newBlocks = [...m.blocks];
          newBlocks[blockIdx] = {
            type: "subagent",
            toolUseId,
            task: { ...subagent },
          };
          next[i] = { ...m, blocks: newBlocks };
          return next;
        }
      }
      return prev;
    });
  }, []);

  /**
   * Get or create a SubagentState for a given toolUseId.
   */
  const getOrCreateSubagent = useCallback(
    (toolUseId: string, defaults?: Partial<SubagentState>): SubagentState => {
      let state = subagentMapRef.current.get(toolUseId);
      if (!state) {
        state = {
          taskId: defaults?.taskId ?? "",
          toolUseId,
          description: defaults?.description ?? "",
          prompt: defaults?.prompt,
          status: defaults?.status ?? "running",
          summary: defaults?.summary,
          result: defaults?.result,
          lastToolName: defaults?.lastToolName,
          usage: defaults?.usage,
          innerBlocks: defaults?.innerBlocks ?? [],
        };
        subagentMapRef.current.set(toolUseId, state);
      }
      return state;
    },
    [],
  );

  // ── SDK message handler ──

  const handleSdkMessage = useCallback(
    (sdk: SDKMessage) => {
      switch (sdk.type) {
        case "assistant": {
          const parentToolUseId = sdk.parent_tool_use_id;

          if (parentToolUseId) {
            // Inner subagent message — fold into subagent's innerBlocks
            const subagent = subagentMapRef.current.get(parentToolUseId);
            if (subagent) {
              const innerContentBlocks = extractBlocks(sdk.message);
              subagent.innerBlocks.push(...innerContentBlocks);
              updateSubagentInMessages(parentToolUseId);
            }
            break;
          }

          // Top-level assistant message
          const blocks = extractBlocks(sdk.message);

          // Detect Agent tool_use blocks and create subagent entries
          const finalBlocks: ContentBlock[] = [];
          for (const block of blocks) {
            if (block.type === "tool_use" && block.name === "Agent") {
              const input = block.input as Record<string, unknown> | undefined;
              const description =
                typeof input?.description === "string"
                  ? input.description
                  : "Subagent";
              const prompt =
                typeof input?.prompt === "string" ? input.prompt : undefined;

              const subagent = getOrCreateSubagent(block.toolUseId, {
                description,
                prompt,
              });
              // Update description/prompt if not yet set (race with task_started)
              if (!subagent.description) subagent.description = description;
              if (!subagent.prompt && prompt) subagent.prompt = prompt;

              finalBlocks.push({
                type: "subagent",
                toolUseId: block.toolUseId,
                task: { ...subagent },
              });
            } else {
              finalBlocks.push(block);
            }
          }

          const text = blocks
            .filter(
              (b): b is ContentBlock & { type: "text" } => b.type === "text",
            )
            .map((b) => b.text)
            .join("");

          // Finalized assistant message — replace any streaming placeholder
          setMessages((prev) => {
            const filtered = prev.filter((m) => !m.isStreaming);
            return [
              ...filtered,
              {
                id: sdk.uuid,
                role: "assistant",
                content: text,
                blocks: finalBlocks,
              },
            ];
          });
          streamBufRef.current = null;
          break;
        }

        case "stream_event": {
          const parentToolUseId = sdk.parent_tool_use_id;

          // Skip subagent streaming text — don't show in main view
          if (parentToolUseId) break;

          const sEvent = sdk.event as Record<string, unknown>;
          if (sEvent.type === "content_block_delta") {
            const delta = sEvent.delta as Record<string, unknown> | undefined;
            if (
              delta?.type === "text_delta" &&
              typeof delta.text === "string"
            ) {
              if (!streamBufRef.current) {
                const id = `stream-${Date.now()}`;
                streamBufRef.current = { id, text: "" };
              }
              streamBufRef.current.text += delta.text;
              const buf = streamBufRef.current;
              setIsStreaming(true);
              setMessages((prev) => {
                const existing = prev.findIndex((m) => m.id === buf.id);
                const updated: ChatMessage = {
                  id: buf.id,
                  role: "assistant",
                  content: buf.text,
                  blocks: [{ type: "text", text: buf.text }],
                  isStreaming: true,
                };
                if (existing >= 0) {
                  const next = [...prev];
                  next[existing] = updated;
                  return next;
                }
                return [...prev, updated];
              });
            }
          }
          break;
        }

        case "user": {
          // Only tool results reach the client (server filters non-tool-result user messages)
          const toolResult = extractToolResultBlock(sdk.message);
          if (!toolResult) break;

          const parentToolUseId = sdk.parent_tool_use_id;

          if (parentToolUseId) {
            // Inner subagent tool result — fold into subagent's innerBlocks
            const subagent = subagentMapRef.current.get(parentToolUseId);
            if (subagent) {
              subagent.innerBlocks.push(toolResult);
              updateSubagentInMessages(parentToolUseId);
            }
            break;
          }

          // Check if this tool_result is for an Agent tool_use (subagent completion fallback)
          const subagent = subagentMapRef.current.get(toolResult.toolUseId);
          if (subagent && subagent.status === "running") {
            // Update subagent status — the Agent tool returned
            subagent.status = "completed";
            subagent.result = toolResult.content || undefined;
            if (!subagent.summary) {
              subagent.summary = toolResult.content
                ? truncateString(toolResult.content, 500)
                : "Completed";
            }
            updateSubagentInMessages(toolResult.toolUseId);
            break;
          }

          // Normal tool_result — attach to the last assistant message's matching tool_use
          setMessages((prev) => {
            const next = [...prev];
            // Walk backwards to find the assistant message containing this tool_use
            for (let i = next.length - 1; i >= 0; i--) {
              const m = next[i];
              if (m.role === "assistant") {
                const hasToolUse = m.blocks.some(
                  (b) =>
                    b.type === "tool_use" &&
                    b.toolUseId === toolResult.toolUseId,
                );
                if (hasToolUse) {
                  next[i] = {
                    ...m,
                    blocks: [...m.blocks, toolResult],
                  };
                  return next;
                }
              }
            }
            // Fallback: couldn't match — append as standalone
            return [
              ...prev,
              {
                id: sdk.uuid ?? `tr-${Date.now()}`,
                role: "assistant",
                content: "",
                blocks: [toolResult],
              },
            ];
          });
          break;
        }

        case "system": {
          const subtype = "subtype" in sdk ? sdk.subtype : undefined;

          if (subtype === "task_started") {
            const msg = sdk as unknown as {
              task_id: string;
              tool_use_id: string;
              description: string;
              prompt?: string;
            };
            const subagent = getOrCreateSubagent(msg.tool_use_id, {
              taskId: msg.task_id,
              description: msg.description,
              prompt: msg.prompt,
            });
            subagent.taskId = msg.task_id;
            if (msg.description) subagent.description = msg.description;
            if (msg.prompt) subagent.prompt = msg.prompt;
            updateSubagentInMessages(msg.tool_use_id);
          } else if (subtype === "task_progress") {
            const msg = sdk as unknown as {
              tool_use_id: string;
              usage: {
                total_tokens: number;
                tool_uses: number;
                duration_ms: number;
              };
              last_tool_name?: string;
            };
            const subagent = subagentMapRef.current.get(msg.tool_use_id);
            if (subagent) {
              subagent.usage = msg.usage;
              if (msg.last_tool_name)
                subagent.lastToolName = msg.last_tool_name;
              updateSubagentInMessages(msg.tool_use_id);
            }
          } else if (subtype === "task_notification") {
            const msg = sdk as unknown as {
              tool_use_id: string;
              status: "completed" | "failed" | "stopped";
              summary: string;
              usage?: {
                total_tokens: number;
                tool_uses: number;
                duration_ms: number;
              };
            };
            const subagent = subagentMapRef.current.get(msg.tool_use_id);
            if (subagent) {
              subagent.status = msg.status;
              subagent.summary = msg.summary;
              if (msg.usage) subagent.usage = msg.usage;
              updateSubagentInMessages(msg.tool_use_id);
            }
          }
          break;
        }

        case "result": {
          setIsStreaming(false);
          streamBufRef.current = null;
          setPendingQuestion(null);
          break;
        }
      }
    },
    [getOrCreateSubagent, updateSubagentInMessages],
  );

  // ── Control message handler ──

  const handleControlMessage = useCallback((ctrl: ControlPayload) => {
    switch (ctrl.type) {
      case "session_message": {
        const text = ctrl.message;
        setMessages((prev) => [
          ...prev,
          {
            id: `user-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            role: "user",
            content: text,
            blocks: [{ type: "text", text }],
          },
        ]);
        if (!isLoadingHistoryRef.current) {
          setIsStreaming(true);
        }
        break;
      }

      case "ask_user_question": {
        setPendingQuestion({
          requestId: ctrl.requestId,
          questions: ctrl.questions,
        });
        break;
      }

      case "error": {
        setError(ctrl.error);
        setIsStreaming(false);
        streamBufRef.current = null;
        break;
      }

      case "history_batch_start": {
        isLoadingHistoryRef.current = true;
        setIsLoadingHistory(true);
        setMessages([]);
        subagentMapRef.current = new Map();
        break;
      }

      case "history_batch_end": {
        isLoadingHistoryRef.current = false;
        setIsLoadingHistory(false);
        break;
      }

      case "todo_update": {
        setTodos(ctrl.todos);
        break;
      }
    }
  }, []);

  useEffect(() => {
    if (!sessionId) {
      wsRef.current?.close();
      wsRef.current = null;
      return;
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(
      `${protocol}//${window.location.host}/ws/sessions/${sessionId}`,
    );
    wsRef.current = ws;

    ws.onmessage = (ev) => {
      let msg: WSServerMessage;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }

      if (msg.category === "sdk") {
        handleSdkMessage(msg.message);
      } else {
        handleControlMessage(msg.message);
      }
    };

    ws.onerror = () => {
      setError("WebSocket connection error");
    };

    ws.onclose = () => {
      setIsStreaming(false);
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [sessionId, handleSdkMessage, handleControlMessage]);

  const sendMessage = useCallback((text: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "message", message: text }));
    setIsStreaming(true);
  }, []);

  const answerQuestion = useCallback(
    (requestId: string, answers: Record<string, string>) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
      wsRef.current.send(
        JSON.stringify({ type: "answer_question", requestId, answers }),
      );
      setPendingQuestion(null);
    },
    [],
  );

  return {
    messages,
    isStreaming,
    isLoadingHistory,
    error,
    pendingQuestion,
    todos,
    sendMessage,
    answerQuestion,
    setMessages,
  };
}

/** Extract all content blocks from an Anthropic message. */
function extractBlocks(message: unknown): ContentBlock[] {
  if (!message || typeof message !== "object") return [];
  const msg = message as Record<string, unknown>;

  // Simple string content
  if (typeof msg.content === "string") {
    return msg.content ? [{ type: "text", text: msg.content }] : [];
  }

  if (!Array.isArray(msg.content)) return [];

  const blocks: ContentBlock[] = [];
  for (const b of msg.content as Array<Record<string, unknown>>) {
    if (b.type === "text" && typeof b.text === "string") {
      blocks.push({ type: "text", text: b.text });
    } else if (b.type === "tool_use") {
      blocks.push({
        type: "tool_use",
        toolUseId: b.id as string,
        name: b.name as string,
        input: b.input,
      });
    } else if (b.type === "tool_result") {
      const content =
        typeof b.content === "string"
          ? b.content
          : Array.isArray(b.content)
            ? (b.content as Array<Record<string, unknown>>)
                .filter((c) => c.type === "text")
                .map((c) => c.text)
                .join("")
            : "";
      blocks.push({
        type: "tool_result",
        toolUseId: b.tool_use_id as string,
        content,
      });
    }
  }
  return blocks;
}

/** Extract a single tool_result block from a tool_result WS message. */
function extractToolResultBlock(
  message: unknown,
): (ContentBlock & { type: "tool_result" }) | null {
  if (!message || typeof message !== "object") return null;
  const msg = message as Record<string, unknown>;
  if (!Array.isArray(msg.content)) return null;

  const block = (msg.content as Array<Record<string, unknown>>).find(
    (b) => b.type === "tool_result",
  );
  if (!block) return null;

  const content =
    typeof block.content === "string"
      ? block.content
      : Array.isArray(block.content)
        ? (block.content as Array<Record<string, unknown>>)
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("")
        : "";
  return {
    type: "tool_result",
    toolUseId: block.tool_use_id as string,
    content,
  };
}

function truncateString(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}
