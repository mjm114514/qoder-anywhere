import { useState, useEffect, useCallback, useRef } from "react";
import { createSession } from "../api";
import { useSessionSocket } from "../hooks/useSessionSocket";
import { MessageList } from "./MessageList";
import type { MessageListHandle } from "./MessageList";
import { ChatInput } from "./ChatInput";
import { AskUserQuestion } from "./AskUserQuestion";
import { TodoPanel } from "./TodoPanel";
import type { SelectedProject } from "../App";
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
  const {
    messages,
    isStreaming,
    isLoadingHistory,
    error,
    pendingQuestion,
    todos,
    sendMessage,
    answerQuestion,
  } = useSessionSocket(selectedSessionId);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const messageListRef = useRef<MessageListHandle>(null);

  // Reset create state when switching away from new session
  useEffect(() => {
    if (!showNewSession) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset on prop change
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
      onSessionCreated(res.sessionId);
    } catch (err) {
      setCreateError(
        err instanceof Error ? err.message : "Failed to create session",
      );
      setCreating(false);
    }
  };

  const handleSend = useCallback(
    (text: string, _model?: string) => {
      sendMessage(text);
      // Scroll to bottom after user sends a message
      requestAnimationFrame(() => {
        messageListRef.current?.scrollToBottom();
      });
    },
    [sendMessage],
  );

  // New session: same layout as active chat, but empty messages + model selector
  if (showNewSession && selectedProject) {
    return (
      <div className="chat-area">
        {createError && <div className="chat-area-error">{createError}</div>}
        <MessageList
          messages={[]}
          isStreaming={false}
          cwd={selectedProject.cwd}
        />
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
      <MessageList
        ref={messageListRef}
        messages={messages}
        isStreaming={isStreaming}
        cwd={selectedProject?.cwd}
      />
      {pendingQuestion && (
        <AskUserQuestion
          pendingQuestion={pendingQuestion}
          onAnswer={answerQuestion}
        />
      )}
      <ChatInput
        onSend={handleSend}
        disabled={isStreaming || isLoadingHistory}
      />
      <TodoPanel todos={todos} />
    </div>
  );
}
