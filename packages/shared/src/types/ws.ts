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

// ── Server → Client ──

export type WSServerMessage =
  | WSInitMessage
  | WSSessionMessage
  | WSAssistantMessage
  | WSStreamEventMessage
  | WSToolResultMessage
  | WSResultMessage
  | WSToolProgressMessage
  | WSStatusMessage
  | WSErrorMessage
  | WSAskUserQuestionMessage
  | WSHistoryBatchStart
  | WSHistoryBatchEnd
  | WSTodoUpdateMessage;

export interface WSInitMessage {
  event: "init";
  data: {
    sessionId: string;
    cwd: string;
    model: string;
  };
}

export interface WSSessionMessage {
  event: "session_message";
  data: {
    message: string;
  };
}

export interface WSAssistantMessage {
  event: "assistant";
  data: {
    type: "assistant";
    uuid: string;
    message: unknown;
  };
}

export interface WSStreamEventMessage {
  event: "stream_event";
  data: {
    type: "stream_event";
    event: unknown;
    parent_tool_use_id: string | null;
  };
}

export interface WSToolResultMessage {
  event: "tool_result";
  data: {
    type: "user";
    uuid?: string;
    message: unknown;
    tool_use_result?: unknown;
  };
}

export interface WSResultMessage {
  event: "result";
  data: {
    subtype: string;
    result?: string;
    session_id: string;
    total_cost_usd: number;
    duration_ms: number;
    num_turns: number;
    errors?: string[];
  };
}

export interface WSToolProgressMessage {
  event: "tool_progress";
  data: unknown;
}

export interface WSStatusMessage {
  event: "status";
  data: unknown;
}

export interface WSErrorMessage {
  event: "error";
  data: {
    error: string;
    code: string;
  };
}

export interface WSAskUserQuestionMessage {
  event: "ask_user_question";
  data: {
    requestId: string;
    questions: AskUserQuestionItem[];
  };
}

export interface WSHistoryBatchStart {
  event: "history_batch_start";
  data: { messageCount: number };
}

export interface WSHistoryBatchEnd {
  event: "history_batch_end";
  data: Record<string, never>;
}

export interface WSTodoUpdateMessage {
  event: "todo_update";
  data: { todos: import("./todo.js").TodoItem[] };
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
