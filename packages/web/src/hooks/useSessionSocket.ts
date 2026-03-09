import { useState, useEffect, useRef, useCallback } from "react";
import type {
  WSServerMessage,
  AskUserQuestionItem,
  TodoItem,
} from "@lgtm-anywhere/shared";

// A single content block in an assistant turn
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; toolUseId: string; name: string; input?: unknown }
  | { type: "tool_result"; toolUseId: string; content: string };

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

  useEffect(() => {
    // Reset pending question whenever session changes
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset on session change
    setPendingQuestion(null);
    setTodos([]);

    if (!sessionId) {
      wsRef.current?.close();
      wsRef.current = null;
      return;
    }

    // Clear stale state from previous session
    setMessages([]);
    setIsStreaming(false);
    setError(null);

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

      switch (msg.event) {
        case "assistant": {
          const blocks = extractBlocks(msg.data.message);
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
                id: msg.data.uuid,
                role: "assistant",
                content: text,
                blocks,
              },
            ];
          });
          streamBufRef.current = null;
          break;
        }

        case "stream_event": {
          const sEvent = msg.data.event as Record<string, unknown>;
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

        case "tool_result": {
          const toolResult = extractToolResultBlock(msg.data.message);
          if (toolResult) {
            // Attach tool_result to the last assistant message's matching tool_use
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
                  id: msg.data.uuid ?? `tr-${Date.now()}`,
                  role: "assistant",
                  content: "",
                  blocks: [toolResult],
                },
              ];
            });
          }
          break;
        }

        case "result": {
          setIsStreaming(false);
          streamBufRef.current = null;
          setPendingQuestion(null);
          break;
        }

        case "ask_user_question": {
          setPendingQuestion({
            requestId: msg.data.requestId,
            questions: msg.data.questions,
          });
          break;
        }

        case "error": {
          setError(msg.data.error);
          setIsStreaming(false);
          streamBufRef.current = null;
          break;
        }

        case "session_message": {
          const text = msg.data.message;
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

        case "history_batch_start": {
          isLoadingHistoryRef.current = true;
          setIsLoadingHistory(true);
          setMessages([]);
          break;
        }

        case "history_batch_end": {
          isLoadingHistoryRef.current = false;
          setIsLoadingHistory(false);
          break;
        }

        case "todo_update": {
          setTodos(msg.data.todos);
          break;
        }
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
  }, [sessionId]);

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
