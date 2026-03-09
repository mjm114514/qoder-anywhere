// ── Client → Server ──

export type WSClientMessage = WSMessageSend;

export interface WSMessageSend {
  type: "message";
  message: string;
}

// ── Server → Client ──

export type WSServerMessage =
  | WSInitMessage
  | WSAssistantMessage
  | WSStreamEventMessage
  | WSToolResultMessage
  | WSResultMessage
  | WSToolProgressMessage
  | WSStatusMessage
  | WSErrorMessage;

export interface WSInitMessage {
  event: "init";
  data: {
    sessionId: string;
    cwd: string;
    model: string;
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

// ── Global sync WebSocket: Server → Client ──

export type WSSyncMessage = WSSessionStateChange;

export interface WSSessionStateChange {
  event: "session_state";
  data: { sessionId: string; state: import("./session.js").SessionState };
}
