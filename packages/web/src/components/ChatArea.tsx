import { useState, useEffect, useCallback, useRef } from "react";
import { fetchSessionDetail, createSession } from "../api";
import { useSessionSocket } from "../hooks/useSessionSocket";
import { extractTextContent, extractContentBlocks } from "../utils/format";
import { MessageList } from "./MessageList";
import { ChatInput } from "./ChatInput";
import type { SelectedProject } from "../App";
import type { ChatMessage } from "../hooks/useSessionSocket";
import "./ChatArea.css";

interface ChatAreaProps {
  selectedProject: SelectedProject | null;
  selectedSessionId: string | null;
  showNewSession: boolean;
  onSessionCreated: (sessionId: string) => void;
}

export function ChatArea({
  selectedProject,
  selectedSessionId,
  showNewSession,
  onSessionCreated,
}: ChatAreaProps) {
  const { messages, isStreaming, error, sendMessage, setMessages } =
    useSessionSocket(selectedSessionId);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // Track sessions we just created — skip loadHistory since WS delivers events in real time
  const justCreatedRef = useRef<Set<string>>(new Set());

  const loadHistory = useCallback(
    async (sessionId: string) => {
      try {
        const detail = await fetchSessionDetail(sessionId);

        // First pass: build all messages with blocks
        const allMessages: ChatMessage[] = detail.messages.map((m) => {
          const text = extractTextContent(m.message);
          const blocks = extractContentBlocks(m.message);
          return {
            id: m.uuid,
            role: m.type as "user" | "assistant",
            content: text,
            blocks: blocks.map((b) => {
              if (b.type === "text") return { type: "text" as const, text: b.text! };
              if (b.type === "tool_use")
                return {
                  type: "tool_use" as const,
                  toolUseId: b.toolUseId!,
                  name: b.name!,
                  input: b.input,
                };
              return {
                type: "tool_result" as const,
                toolUseId: b.toolUseId!,
                content: b.content ?? "",
              };
            }),
          };
        });

        // Second pass: merge tool_result messages into the corresponding assistant message
        const merged: ChatMessage[] = [];
        for (const m of allMessages) {
          if (m.role === "user" && m.blocks.some((b) => b.type === "tool_result")) {
            const toolResults = m.blocks.filter((b) => b.type === "tool_result");
            let matched = false;
            for (let i = merged.length - 1; i >= 0; i--) {
              if (merged[i].role === "assistant") {
                merged[i] = {
                  ...merged[i],
                  blocks: [...merged[i].blocks, ...toolResults],
                };
                matched = true;
                break;
              }
            }
            if (!matched) {
              merged.push(m);
            }
          } else {
            merged.push(m);
          }
        }

        setMessages(merged);
      } catch {
        setMessages([]);
      }
    },
    [setMessages]
  );

  useEffect(() => {
    if (selectedSessionId) {
      if (justCreatedRef.current.has(selectedSessionId)) {
        // Newly created session — messages already seeded, WS will deliver the rest
        justCreatedRef.current.delete(selectedSessionId);
        return;
      }
      loadHistory(selectedSessionId);
    } else {
      setMessages([]);
    }
  }, [selectedSessionId, loadHistory, setMessages]);

  // Reset create state when switching away from new session
  useEffect(() => {
    if (!showNewSession) {
      setCreating(false);
      setCreateError(null);
    }
  }, [showNewSession]);

  const handleNewSessionSend = async (text: string, model?: string) => {
    if (!selectedProject || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await createSession(selectedProject.cwd, {
        message: text,
        model: model || undefined,
      });
      // Seed the user message so it appears immediately when the session view loads
      setMessages([
        {
          id: `user-${Date.now()}`,
          role: "user",
          content: text,
          blocks: [{ type: "text", text }],
        },
      ]);
      justCreatedRef.current.add(res.sessionId);
      onSessionCreated(res.sessionId);
    } catch (err) {
      setCreateError(
        err instanceof Error ? err.message : "Failed to create session"
      );
      setCreating(false);
    }
  };

  // New session: same layout as active chat, but empty messages + model selector
  if (showNewSession && selectedProject) {
    return (
      <div className="chat-area">
        {createError && <div className="chat-area-error">{createError}</div>}
        <MessageList messages={[]} isStreaming={false} cwd={selectedProject.cwd} />
        <ChatInput
          onSend={handleNewSessionSend}
          disabled={creating}
          placeholder={
            creating
              ? "Creating session..."
              : "What would you like Claude to help with?"
          }
        />
      </div>
    );
  }

  if (!selectedSessionId) {
    return (
      <div className="chat-area">
        <div className="chat-area-empty">
          {selectedProject
            ? "Select a session or create a new one"
            : "Select a project to get started"}
        </div>
      </div>
    );
  }

  return (
    <div className="chat-area">
      {error && <div className="chat-area-error">{error}</div>}
      <MessageList messages={messages} isStreaming={isStreaming} cwd={selectedProject?.cwd} />
      <ChatInput onSend={sendMessage} disabled={isStreaming} />
    </div>
  );
}
