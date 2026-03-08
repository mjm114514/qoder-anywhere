export type SSEEvent =
  | SSEInitEvent
  | SSEAssistantEvent
  | SSEStreamEvent
  | SSEToolResultEvent
  | SSEResultEvent
  | SSEToolProgressEvent
  | SSEStatusEvent
  | SSEErrorEvent;

export interface SSEInitEvent {
  event: "init";
  data: {
    sessionId: string;
    cwd: string;
    model: string;
  };
}

export interface SSEAssistantEvent {
  event: "assistant";
  data: {
    type: "assistant";
    uuid: string;
    message: unknown;
  };
}

export interface SSEStreamEvent {
  event: "stream_event";
  data: {
    type: "stream_event";
    event: unknown;
    parent_tool_use_id: string | null;
  };
}

export interface SSEToolResultEvent {
  event: "tool_result";
  data: {
    type: "user";
    uuid?: string;
    message: unknown;
    tool_use_result?: unknown;
  };
}

export interface SSEResultEvent {
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

export interface SSEToolProgressEvent {
  event: "tool_progress";
  data: unknown;
}

export interface SSEStatusEvent {
  event: "status";
  data: unknown;
}

export interface SSEErrorEvent {
  event: "error";
  data: {
    error: string;
    code: string;
  };
}
