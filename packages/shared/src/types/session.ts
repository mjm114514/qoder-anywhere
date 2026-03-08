export type SessionState = "active" | "idle" | "inactive";

export interface SessionSummary {
  sessionId: string;
  summary: string;
  lastModified: number;
  fileSize: number;
  cwd?: string;
  gitBranch?: string;
  state: SessionState;
}

export interface SessionDetail {
  sessionId: string;
  summary: string;
  lastModified: number;
  state: SessionState;
  messages: SessionMessage[];
}

export interface SessionMessage {
  type: "user" | "assistant";
  uuid: string;
  message: unknown;
}
