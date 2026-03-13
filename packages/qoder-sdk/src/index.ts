/**
 * qoder-sdk — TypeScript SDK for qodercli
 *
 * Public API:
 *   - query()              — spawn qodercli and stream messages
 *   - listSessions()       — list sessions from filesystem
 *   - getSessionMessages() — read a session transcript
 *   - MessageQueue         — AsyncIterable bridge for streaming input
 *
 * @example
 * ```ts
 * import { query, listSessions, getSessionMessages, MessageQueue } from "qoder-sdk";
 * ```
 */

// Core API
export { query } from "./query.js";
export type { QueryParams } from "./query.js";
export { listSessions, getSessionMessages } from "./sessions.js";

// Utilities
export { MessageQueue } from "./message-queue.js";
export { ProcessTransport } from "./transport.js";
export {
  cwdToProjectDir,
  resolveConfigDir,
  resolveProjectsDir,
  parseJsonLine,
  parseJsonLines,
} from "./utils.js";

// Types
export type {
  // Content blocks
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
  ToolResultBlock,
  ContentBlock,
  UsageInfo,
  // Stream event types (for --include-partial-messages)
  TextDelta,
  ThinkingDelta,
  InputJsonDelta,
  StreamDelta,
  StreamEventData,
  // Messages from qodercli
  QoderSystemMessage,
  QoderSystemInitMessage,
  QoderSystemStatusMessage,
  QoderTaskStartedMessage,
  QoderTaskProgressMessage,
  QoderTaskNotificationMessage,
  QoderAssistantMessage,
  QoderUserEchoMessage,
  QoderStreamEvent,
  QoderResultMessage,
  QoderToolProgressMessage,
  QoderMessage,
  QoderUserMessageReplay,
  // Messages to qodercli
  QoderUserMessage,
  // Control protocol (internal)
  QoderControlRequest,
  QoderControlResponse,
  QoderControlResponseFromCli,
  // Options
  PermissionMode,
  ModelLevel,
  AgentDefinition,
  CanUseTool,
  CanUseToolOptions,
  PermissionResult,
  PermissionUpdate,
  PermissionBehavior,
  PermissionRuleValue,
  PermissionUpdateDestination,
  QueryOptions,
  Query,
  // Session types
  QoderSessionInfo,
  RawSessionJson,
  QoderSessionMessage,
  ListSessionsOptions,
  GetSessionMessagesOptions,
  // Claude Agent SDK compatibility aliases
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKUserMessageReplay,
} from "./types.js";
