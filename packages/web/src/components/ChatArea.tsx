import { useState, useCallback, useRef, useEffect } from "react";
import type {
  PermissionMode,
  UserImageAttachment,
} from "@lgtm-anywhere/shared";
import { createSession } from "../api";
import { useSessionSocket } from "../hooks/useSessionSocket";
import { MessageList } from "./MessageList";
import type { MessageListHandle } from "./MessageList";
import { ChatInput } from "./ChatInput";
import { AskUserQuestion } from "./AskUserQuestion";
import { ToolApproval } from "./ToolApproval";
import { TodoPanel } from "./TodoPanel";
import type { SelectedProject } from "../App";
import "./ChatArea.css";

const PERMISSION_MODE_OPTIONS: {
  label: string;
  value: PermissionMode;
  color: string;
}[] = [
  { label: "Bypass", value: "bypassPermissions", color: "#c62828" },
  { label: "Default", value: "default", color: "#1976d2" },
  { label: "Accept Edits", value: "acceptEdits", color: "#9c27b0" },
  { label: "Plan", value: "plan", color: "#4caf50" },
  { label: "Don't Ask", value: "dontAsk", color: "#78909c" },
];

function getPermissionColor(mode: PermissionMode): string {
  return (
    PERMISSION_MODE_OPTIONS.find((o) => o.value === mode)?.color ?? "#78909c"
  );
}

function PermissionModeSelect({
  value,
  onChange,
}: {
  value: PermissionMode;
  onChange: (mode: PermissionMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const current = PERMISSION_MODE_OPTIONS.find((o) => o.value === value);

  return (
    <div className="perm-select" ref={ref}>
      <button
        className="perm-select-trigger"
        onClick={() => setOpen((o) => !o)}
      >
        <span
          className="perm-dot"
          style={{ background: getPermissionColor(value) }}
        />
        <span className="perm-select-label">{current?.label ?? value}</span>
        <span className="perm-select-arrow" />
      </button>
      {open && (
        <div className="perm-select-dropdown">
          {PERMISSION_MODE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              className={`perm-select-option ${opt.value === value ? "perm-select-option--active" : ""}`}
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
            >
              <span className="perm-dot" style={{ background: opt.color }} />
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface ChatAreaProps {
  selectedProject: SelectedProject | null;
  selectedSessionId: string | null;
  sessionSummary: string;
  showNewSession: boolean;
  onSessionCreated: (sessionId: string) => void;
}

export function ChatArea({
  selectedProject,
  selectedSessionId,
  sessionSummary,
  showNewSession,
  onSessionCreated,
}: ChatAreaProps) {
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [newSessionPermMode, setNewSessionPermMode] =
    useState<PermissionMode>("bypassPermissions");
  const {
    messages,
    isStreaming,
    isLoadingHistory,
    error,
    pendingQuestion,
    pendingToolApproval,
    permissionMode,
    todos,
    sendMessage,
    answerQuestion,
    answerToolApproval,
    setPermissionMode,
  } = useSessionSocket(selectedSessionId, newSessionPermMode);
  const messageListRef = useRef<MessageListHandle>(null);

  // Reset create state when switching away from new session.
  // Track prev value via state so React batches the reset into the same render.
  const [prevShowNewSession, setPrevShowNewSession] = useState(showNewSession);
  if (prevShowNewSession !== showNewSession) {
    setPrevShowNewSession(showNewSession);
    if (!showNewSession) {
      setCreating(false);
      setCreateError(null);
    }
  }

  const handleNewSessionSend = async (
    text: string,
    model?: string,
    images?: UserImageAttachment[],
  ) => {
    if (!selectedProject || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await createSession(selectedProject.cwd, {
        message: text,
        model: model || undefined,
        permissionMode: newSessionPermMode,
        ...(images?.length ? { images } : {}),
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
    (text: string, _model?: string, images?: UserImageAttachment[]) => {
      sendMessage(text, images);
      // Scroll to bottom after user sends a message
      requestAnimationFrame(() => {
        messageListRef.current?.scrollToBottom();
      });
    },
    [sendMessage],
  );

  const handlePermissionModeChange = useCallback(
    (mode: PermissionMode) => {
      setPermissionMode(mode);
      setNewSessionPermMode(mode);
    },
    [setPermissionMode],
  );

  // New session: header + empty messages + input
  if (showNewSession && selectedProject) {
    return (
      <div className="chat-area">
        <div className="chat-area-header">
          <span className="chat-area-header-title">New Session</span>
          <PermissionModeSelect
            value={newSessionPermMode}
            onChange={setNewSessionPermMode}
          />
        </div>
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
      <div className="chat-area-header">
        <span className="chat-area-header-title">
          {sessionSummary || selectedSessionId.slice(0, 8)}
        </span>
        <PermissionModeSelect
          value={permissionMode}
          onChange={handlePermissionModeChange}
        />
      </div>
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
      {pendingToolApproval && (
        <ToolApproval
          pendingToolApproval={pendingToolApproval}
          onAnswer={answerToolApproval}
          onSetPermissionMode={handlePermissionModeChange}
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
