export interface CreateSessionRequest {
  message: string;
  model?: string;
  permissionMode?: string;
  allowedTools?: string[];
  systemPrompt?: string;
  maxTurns?: number;
  images?: import("./ws.js").UserImageAttachment[];
}

export interface SendMessageRequest {
  message: string;
}

export interface UpdateSessionRequest {
  title?: string;
  model?: string;
  permissionMode?: string;
}

export interface UpdateSessionResponse {
  sessionId: string;
  title?: string;
  model?: string;
  permissionMode?: string;
}

export interface CreateSessionResponse {
  sessionId: string;
}

export interface DeleteSessionResponse {
  sessionId: string;
  stopped: boolean;
  fileDeleted: boolean;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}
