import { useEffect, useCallback } from "react";
import { fetchSessionDetail } from "../api";
import { useSessionSocket } from "../hooks/useSessionSocket";
import { extractTextContent, extractToolUse } from "../utils/format";
import { MessageList } from "./MessageList";
import { ChatInput } from "./ChatInput";
import { NewSessionForm } from "./NewSessionForm";
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

  const loadHistory = useCallback(
    async (sessionId: string) => {
      try {
        const detail = await fetchSessionDetail(sessionId);
        const historical: ChatMessage[] = detail.messages.map((m) => {
          const text = extractTextContent(m.message);
          const tools = extractToolUse(m.message);
          return {
            id: m.uuid,
            role: m.type as "user" | "assistant",
            content: text,
            toolUse: tools.length > 0 ? tools[0] : undefined,
          };
        });
        setMessages(historical);
      } catch {
        // Session detail may fail for inactive sessions; start with empty
        setMessages([]);
      }
    },
    [setMessages]
  );

  useEffect(() => {
    if (selectedSessionId) {
      loadHistory(selectedSessionId);
    } else {
      setMessages([]);
    }
  }, [selectedSessionId, loadHistory, setMessages]);

  if (showNewSession && selectedProject) {
    return (
      <div className="chat-area">
        <NewSessionForm
          cwd={selectedProject.cwd}
          onCreated={onSessionCreated}
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
      <MessageList messages={messages} isStreaming={isStreaming} />
      <ChatInput onSend={sendMessage} disabled={isStreaming} />
    </div>
  );
}
