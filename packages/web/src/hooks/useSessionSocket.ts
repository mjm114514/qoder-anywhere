import { useState, useEffect, useRef, useCallback } from "react";
import type { WSServerMessage } from "@lgtm-anywhere/shared";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolUse?: { name: string; id: string };
  toolResult?: { toolUseId: string; content: string };
  isStreaming?: boolean;
}

interface UseSessionSocketReturn {
  messages: ChatMessage[];
  isStreaming: boolean;
  error: string | null;
  sendMessage: (text: string) => void;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
}

export function useSessionSocket(
  sessionId: string | null
): UseSessionSocketReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const streamBufRef = useRef<{ id: string; text: string } | null>(null);

  useEffect(() => {
    if (!sessionId) {
      wsRef.current?.close();
      wsRef.current = null;
      return;
    }

    setError(null);

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(
      `${protocol}//${window.location.host}/ws/sessions/${sessionId}`
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
          const text = extractText(msg.data.message);
          const toolUse = extractToolUse(msg.data.message);
          // Finalized assistant message — replace any streaming placeholder
          setMessages((prev) => {
            const filtered = prev.filter(
              (m) => !(m.id === msg.data.uuid && m.isStreaming)
            );
            return [
              ...filtered,
              {
                id: msg.data.uuid,
                role: "assistant",
                content: text,
                toolUse: toolUse ?? undefined,
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
            if (delta?.type === "text_delta" && typeof delta.text === "string") {
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
          const text = extractText(msg.data.message);
          if (text) {
            const toolResult = extractToolResult(msg.data.message);
            setMessages((prev) => [
              ...prev,
              {
                id: msg.data.uuid ?? `tr-${Date.now()}`,
                role: "user",
                content: text,
                toolResult: toolResult ?? undefined,
              },
            ]);
          }
          break;
        }

        case "result": {
          setIsStreaming(false);
          streamBufRef.current = null;
          break;
        }

        case "error": {
          setError(msg.data.error);
          setIsStreaming(false);
          streamBufRef.current = null;
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

  const sendMessage = useCallback(
    (text: string) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
      // Add user message to local state immediately
      setMessages((prev) => [
        ...prev,
        { id: `user-${Date.now()}`, role: "user", content: text },
      ]);
      wsRef.current.send(JSON.stringify({ type: "message", message: text }));
      setIsStreaming(true);
    },
    []
  );

  return { messages, isStreaming, error, sendMessage, setMessages };
}

function extractText(message: unknown): string {
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

function extractToolUse(
  message: unknown
): { name: string; id: string } | null {
  if (!message || typeof message !== "object") return null;
  const msg = message as Record<string, unknown>;
  if (!Array.isArray(msg.content)) return null;
  const block = (msg.content as Array<Record<string, unknown>>).find(
    (b) => b.type === "tool_use"
  );
  if (!block) return null;
  return { name: block.name as string, id: block.id as string };
}

function extractToolResult(
  message: unknown
): { toolUseId: string; content: string } | null {
  if (!message || typeof message !== "object") return null;
  const msg = message as Record<string, unknown>;
  if (!Array.isArray(msg.content)) return null;
  const block = (msg.content as Array<Record<string, unknown>>).find(
    (b) => b.type === "tool_result"
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
  return { toolUseId: block.tool_use_id as string, content };
}
