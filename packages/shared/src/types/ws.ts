import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

// ── Client → Server ──

export type WSClientMessage = WSMessageSend | WSAnswerQuestion;

export interface WSMessageSend {
  type: "message";
  message: string;
}

export interface WSAnswerQuestion {
  type: "answer_question";
  requestId: string;
  answers: Record<string, string>;
}

// ── AskUserQuestion types ──

export interface AskUserQuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface AskUserQuestionItem {
  question: string;
  header: string;
  options: AskUserQuestionOption[];
  multiSelect: boolean;
}

// ── Server → Client: Two-category envelope ──
//
// 1. "sdk"     — raw SDK messages forwarded verbatim (no translation)
// 2. "control" — server-originated messages (session_message, ask_user_question, etc.)

export interface WSSdkMessage {
  category: "sdk";
  message: SDKMessage;
}

export interface WSControlMessage {
  category: "control";
  message: ControlPayload;
}

export type WSServerMessage = WSSdkMessage | WSControlMessage;

// ── Control payload discriminated union ──

export type ControlPayload =
  | ControlSessionMessage
  | ControlAskUserQuestion
  | ControlError
  | ControlHistoryBatchStart
  | ControlHistoryBatchEnd
  | ControlTodoUpdate;

export interface ControlSessionMessage {
  type: "session_message";
  message: string;
}

export interface ControlAskUserQuestion {
  type: "ask_user_question";
  requestId: string;
  questions: AskUserQuestionItem[];
}

export interface ControlError {
  type: "error";
  error: string;
  code: string;
}

export interface ControlHistoryBatchStart {
  type: "history_batch_start";
  messageCount: number;
}

export interface ControlHistoryBatchEnd {
  type: "history_batch_end";
}

export interface ControlTodoUpdate {
  type: "todo_update";
  todos: import("./todo.js").TodoItem[];
}

// ── Global sync WebSocket: Server → Client ──

export type WSSyncMessage = WSSessionStateChange | WSSessionCreated;

export interface WSSessionStateChange {
  event: "session_state";
  data: { sessionId: string; state: import("./session.js").SessionState };
}

export interface WSSessionCreated {
  event: "session_created";
  data: { sessionId: string; cwd: string };
}
