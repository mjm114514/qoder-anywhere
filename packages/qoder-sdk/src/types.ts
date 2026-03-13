/**
 * qoder-sdk type definitions
 *
 * Maps the qodercli NDJSON stdio protocol to TypeScript types,
 * mirroring the API shape of @anthropic-ai/claude-agent-sdk.
 *
 * All types are based on actual protocol probing of qodercli
 * with `--input-format stream-json --output-format stream-json`.
 */

// ---------------------------------------------------------------------------
// Content blocks (used inside messages)
// ---------------------------------------------------------------------------

export type TextBlock = {
  type: "text";
  text: string;
};

export type ThinkingBlock = {
  type: "thinking";
  thinking: string;
  signature: string;
};

export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};

/**
 * Tool result block as echoed back in user messages from qodercli.
 *
 * When qodercli executes a tool and reports the result, it sends a
 * `type: "user"` message containing tool_result blocks with these fields.
 */
export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  /** Tool name (echoed back from the tool_use block) */
  name?: string;
  /** The tool output content */
  content: string;
  /** Whether the tool execution resulted in an error */
  is_error?: boolean;
  /** Error code if the tool execution failed */
  err_code?: number;
  /** Whether the tool execution was canceled */
  canceled?: boolean;
  /** Additional metadata about the tool execution */
  metadata?: Record<string, unknown>;
};

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock;

// ---------------------------------------------------------------------------
// Usage info attached to result messages
// ---------------------------------------------------------------------------

export type UsageInfo = {
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  input_tokens: number;
  output_tokens: number;
};

// ---------------------------------------------------------------------------
// Stream event delta types (for --include-partial-messages)
// ---------------------------------------------------------------------------

export type TextDelta = {
  type: "text_delta";
  text: string;
};

export type ThinkingDelta = {
  type: "thinking_delta";
  thinking: string;
};

export type InputJsonDelta = {
  type: "input_json_delta";
  partial_json: string;
};

export type StreamDelta = TextDelta | ThinkingDelta | InputJsonDelta;

export type StreamEventData =
  | {
      type: "content_block_start";
      index: number;
      content_block: ContentBlock;
    }
  | {
      type: "content_block_delta";
      index: number;
      delta: StreamDelta;
    }
  | {
      type: "content_block_stop";
      index: number;
    }
  | {
      type: "message_start";
      message: Record<string, unknown>;
    }
  | {
      type: "message_delta";
      delta: Record<string, unknown>;
      usage?: UsageInfo;
    }
  | {
      type: "message_stop";
    };

// ---------------------------------------------------------------------------
// Raw NDJSON messages from qodercli stdout (stream-json output)
// ---------------------------------------------------------------------------

/**
 * System init message — first message from qodercli.
 * Contains tools list, model, session_id, permission_mode.
 *
 * Actual format:
 * ```json
 * {"model":"Performance","permission_mode":"yolo","session_id":"...","subtype":"init","tools":[...],"type":"system","uuid":"..."}
 * ```
 */
export type QoderSystemInitMessage = {
  type: "system";
  subtype: "init";
  tools: string[];
  model: string;
  session_id: string;
  permission_mode: string;
  /** Permission mode in camelCase (Claude SDK compat). */
  permissionMode?: string;
  uuid: string;
};

/**
 * System status message — transient status updates from qodercli.
 * May carry permissionMode changes (e.g. after ExitPlanMode).
 */
export type QoderSystemStatusMessage = {
  type: "system";
  subtype: "status";
  session_id: string;
  uuid: string;
  /** Current permission mode (synced from CLI). */
  permissionMode?: string;
  [key: string]: unknown;
};

/**
 * Background task started — a subagent was spawned.
 */
export type QoderTaskStartedMessage = {
  type: "system";
  subtype: "task_started";
  session_id: string;
  uuid: string;
  task_id: string;
  tool_use_id: string;
  description: string;
  prompt?: string;
};

/**
 * Background task progress — periodic updates from a running subagent.
 */
export type QoderTaskProgressMessage = {
  type: "system";
  subtype: "task_progress";
  session_id: string;
  uuid: string;
  task_id: string;
  tool_use_id: string;
  usage?: {
    total_tokens: number;
    tool_uses: number;
    duration_ms: number;
  };
  last_tool_name?: string;
};

/**
 * Background task notification — a subagent completed, failed, or was stopped.
 */
export type QoderTaskNotificationMessage = {
  type: "system";
  subtype: "task_notification";
  session_id: string;
  uuid: string;
  task_id: string;
  tool_use_id: string;
  status: "completed" | "failed" | "stopped";
  summary: string;
  usage?: {
    total_tokens: number;
    tool_uses: number;
    duration_ms: number;
  };
};

/**
 * Union of all system message subtypes from qodercli.
 */
export type QoderSystemMessage =
  | QoderSystemInitMessage
  | QoderSystemStatusMessage
  | QoderTaskStartedMessage
  | QoderTaskProgressMessage
  | QoderTaskNotificationMessage;

/**
 * Assistant message — text, thinking, and/or tool_use content blocks.
 *
 * Actual format:
 * ```json
 * {"message":{"role":"assistant","content":[{"text":"...","type":"text"}],"model":""},"session_id":"...","type":"assistant","uuid":"..."}
 * ```
 */
export type QoderAssistantMessage = {
  type: "assistant";
  session_id: string;
  uuid: string;
  /** Tool use ID of the parent agent, if this is a subagent message. */
  parent_tool_use_id?: string | null;
  message: {
    role: "assistant" | string;
    content: ContentBlock[];
    model: string;
  };
};

/**
 * User echo message — tool results echoed back from qodercli.
 *
 * When qodercli executes a tool, it sends the result back as a user message
 * containing tool_result content blocks. These are NOT user-initiated messages.
 *
 * Actual format:
 * ```json
 * {"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"...","name":"Read","content":"...","is_error":true,"err_code":49401,"canceled":false}]},"session_id":"...","type":"user","uuid":"..."}
 * ```
 */
export type QoderUserEchoMessage = {
  type: "user";
  session_id: string;
  uuid: string;
  /** Tool use ID of the parent agent, if this is a subagent tool result. */
  parent_tool_use_id?: string | null;
  /** Present when this is a tool execution result. */
  tool_use_result?: boolean;
  message: {
    role: "user";
    content: ToolResultBlock[];
  };
};

/**
 * Stream event message — partial/streaming content (only with --include-partial-messages).
 *
 * Contains delta updates as the model generates content.
 *
 * Actual format:
 * ```json
 * {"event":{"delta":{"text":"HELLO","type":"text_delta"},"index":0,"type":"content_block_delta"},"session_id":"...","type":"stream_event","uuid":"..."}
 * ```
 */
export type QoderStreamEvent = {
  type: "stream_event";
  session_id: string;
  uuid: string;
  /** Tool use ID of the parent agent, if this is a subagent stream event. */
  parent_tool_use_id?: string | null;
  event: StreamEventData;
};

/**
 * Result message — signals conversation completion (success or error).
 *
 * Success format:
 * ```json
 * {"duration_api_ms":2801,"duration_ms":3054,"errors":[],"is_error":false,"num_turns":1,"result":"HELLO","session_id":"...","subtype":"success","total_cost_usd":0,"type":"result","usage":{...}}
 * ```
 *
 * Error format:
 * ```json
 * {"duration_api_ms":996,"duration_ms":1242,"errors":[...],"is_error":true,"num_turns":1,"result":"","session_id":"...","subtype":"error_during_execution","total_cost_usd":0,"type":"result","uuid":"..."}
 * ```
 */
export type QoderResultMessage = {
  type: "result";
  subtype: "success" | "error_during_execution" | string;
  session_id: string;
  uuid?: string;
  /** The final text result (empty string on error) */
  result: string;
  /** Whether this result represents an error */
  is_error: boolean;
  /** Error details if any */
  errors: unknown[];
  /** Number of agentic turns executed */
  num_turns: number;
  /** Time spent in API calls (ms) */
  duration_api_ms: number;
  /** Total wall-clock time (ms) */
  duration_ms: number;
  /** Total cost in USD */
  total_cost_usd: number;
  /** Token usage summary */
  usage: UsageInfo;
};

/**
 * Tool execution progress event.
 * Broadcast live to show elapsed time for running tools.
 */
export type QoderToolProgressMessage = {
  type: "tool_progress";
  session_id: string;
  uuid: string;
  tool_use_id: string;
  /** Elapsed time since tool started (ms). */
  elapsed_ms?: number;
  [key: string]: unknown;
};

/**
 * Union of all NDJSON messages yielded by query().
 *
 * The `result` message signals the end of the conversation.
 * There is no `done` field on messages — check `type === "result"` instead.
 */
export type QoderMessage =
  | QoderSystemMessage
  | QoderAssistantMessage
  | QoderUserEchoMessage
  | QoderStreamEvent
  | QoderResultMessage
  | QoderToolProgressMessage;

/**
 * Replayed user message from a resumed session.
 * Structurally identical to QoderUserEchoMessage, with an isReplay marker.
 */
export type QoderUserMessageReplay = QoderUserEchoMessage & {
  isReplay?: true;
};

// ---------------------------------------------------------------------------
// User messages sent to qodercli stdin (stream-json input)
// ---------------------------------------------------------------------------

export type QoderUserMessage = {
  type: "user";
  message: {
    role: "user";
    content: string | ContentBlock[];
  };
  session_id: string;
  parent_tool_use_id?: string | null;
};

// ---------------------------------------------------------------------------
// canUseTool — permission callback (matches @anthropic-ai/claude-agent-sdk)
// ---------------------------------------------------------------------------

/**
 * Behavior values for permission rules.
 * Mirrors `PermissionBehavior` from `@anthropic-ai/claude-agent-sdk`.
 */
export type PermissionBehavior = "allow" | "deny" | "ask";

/**
 * A single permission rule entry (tool name + optional rule content).
 * Mirrors `PermissionRuleValue` from `@anthropic-ai/claude-agent-sdk`.
 */
export type PermissionRuleValue = {
  toolName: string;
  ruleContent?: string;
};

/**
 * Where a permission update should be persisted.
 * Mirrors `PermissionUpdateDestination` from `@anthropic-ai/claude-agent-sdk`.
 */
export type PermissionUpdateDestination =
  | "userSettings"
  | "projectSettings"
  | "localSettings"
  | "session"
  | "cliArg";

/**
 * A permission update that can be returned from `canUseTool` to change
 * session-level permissions so the user won't be prompted again.
 *
 * Mirrors `PermissionUpdate` from `@anthropic-ai/claude-agent-sdk`.
 */
export type PermissionUpdate =
  | {
      type: "addRules";
      rules: PermissionRuleValue[];
      behavior: PermissionBehavior;
      destination: PermissionUpdateDestination;
    }
  | {
      type: "replaceRules";
      rules: PermissionRuleValue[];
      behavior: PermissionBehavior;
      destination: PermissionUpdateDestination;
    }
  | {
      type: "removeRules";
      rules: PermissionRuleValue[];
      behavior: PermissionBehavior;
      destination: PermissionUpdateDestination;
    }
  | {
      type: "setMode";
      mode: PermissionMode;
      destination: PermissionUpdateDestination;
    }
  | {
      type: "addDirectories";
      directories: string[];
      destination: PermissionUpdateDestination;
    }
  | {
      type: "removeDirectories";
      directories: string[];
      destination: PermissionUpdateDestination;
    };

/**
 * Result of a canUseTool permission check.
 */
export type PermissionResult =
  | {
      /** Allow the tool to execute. */
      behavior: "allow";
      /** Optionally modify the tool input before execution. */
      updatedInput?: Record<string, unknown>;
      /** Permission updates to apply so the user won't be prompted again. */
      updatedPermissions?: PermissionUpdate[];
      /** Unique identifier for this tool call (echo back from options). */
      toolUseID?: string;
    }
  | {
      /** Deny the tool execution. */
      behavior: "deny";
      /** Reason for denial (shown to the model). */
      message: string;
      /** If true, also interrupt the current agent loop. */
      interrupt?: boolean;
      /** Unique identifier for this tool call (echo back from options). */
      toolUseID?: string;
    };

/**
 * Options passed to the canUseTool callback as the 3rd parameter.
 * Mirrors the options object from `@anthropic-ai/claude-agent-sdk`.
 */
export type CanUseToolOptions = {
  /** Signaled if the operation should be aborted. */
  signal: AbortSignal;
  /**
   * Suggestions for updating permissions so that the user will not be
   * prompted again for this tool during this session.
   */
  suggestions?: PermissionUpdate[];
  /**
   * The file path that triggered the permission request, if applicable.
   */
  blockedPath?: string;
  /** Explains why this permission request was triggered. */
  decisionReason?: string;
  /**
   * Unique identifier for this specific tool call within the assistant message.
   */
  toolUseID: string;
  /** If running within the context of a sub-agent, the sub-agent's ID. */
  agentID?: string;
};

/**
 * Custom permission handler for controlling tool usage.
 *
 * Called before each tool execution when qodercli sends a `control_request`
 * with `subtype: "can_use_tool"`. Return `{ behavior: "allow" }` to proceed
 * or `{ behavior: "deny", message: "..." }` to block.
 *
 * Mirrors the `canUseTool` callback from `@anthropic-ai/claude-agent-sdk`.
 */
export type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: CanUseToolOptions,
) => Promise<PermissionResult>;

// ---------------------------------------------------------------------------
// Control protocol messages (internal, between SDK and qodercli)
// ---------------------------------------------------------------------------

/**
 * Control request from qodercli → SDK (e.g. permission checks).
 * These are intercepted internally by the SDK and NOT yielded to consumers.
 */
export type QoderControlRequest = {
  type: "control_request";
  request_id: string;
  session_id: string;
  uuid: string;
  request: {
    subtype: "can_use_tool";
    tool_name: string;
    input: Record<string, unknown>;
  };
};

/**
 * Control response from SDK → qodercli (sent via stdin).
 */
export type QoderControlResponse = {
  type: "control_response";
  response: {
    subtype: "success";
    request_id: string;
    response: PermissionResult;
  };
};

/**
 * Control response from qodercli → SDK (e.g. ack of initialize/interrupt).
 * These are intercepted internally and NOT yielded to consumers.
 */
export type QoderControlResponseFromCli = {
  type: "control_response";
  session_id: string;
  uuid: string;
  response: {
    subtype: "success" | string;
    request_id: string;
    response: Record<string, unknown>;
  };
};

// ---------------------------------------------------------------------------
// Query options (mapped to qodercli CLI flags)
// ---------------------------------------------------------------------------

/**
 * Permission mode for controlling how tool executions are handled.
 *
 * Mirrors `PermissionMode` from `@anthropic-ai/claude-agent-sdk`:
 * - `'default'` — Standard behavior, prompts for dangerous operations.
 * - `'acceptEdits'` — Auto-accept file edit operations.
 * - `'bypassPermissions'` — Bypass all permission checks (→ --dangerously-skip-permissions / --yolo).
 * - `'plan'` — Planning mode, no actual tool execution.
 * - `'dontAsk'` — Don't prompt for permissions, deny if not pre-approved.
 * - `'yolo'` — Alias for `'bypassPermissions'` (qoder-sdk backward compat).
 *
 * Note: qodercli currently only supports `'default'` and `'yolo'`/`'bypassPermissions'`.
 * Other modes are defined for forward compatibility with future qodercli releases.
 */
export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk"
  | "yolo";

/**
 * Available model levels for qodercli.
 * Maps to `--model` CLI flag choices.
 */
export type ModelLevel =
  | "auto"
  | "efficient"
  | "gmodel"
  | "kmodel"
  | "lite"
  | "mmodel"
  | "performance"
  | "q35model"
  | "qmodel"
  | "ultimate";

/**
 * Agent definition for custom subagents.
 * Passed to qodercli via `--agents` as a JSON object.
 */
export type AgentDefinition = {
  /** Natural language description of when to use this agent */
  description: string;
  /** The agent's system prompt */
  prompt: string;
  /** Array of allowed tool names. If omitted, inherits all tools from parent */
  tools?: string[];
  /** Array of tool names to explicitly disallow for this agent */
  disallowedTools?: string[];
  /** Model alias. If omitted, uses the main model */
  model?: ModelLevel;
  /** Maximum number of agentic turns before stopping */
  maxTurns?: number;
};

/**
 * Options for the query function.
 *
 * Mirrors the shape of `@anthropic-ai/claude-agent-sdk` Options where applicable,
 * mapped to qodercli CLI flags.
 */
export type QueryOptions = {
  /**
   * Current working directory for the session → --workspace
   * Defaults to the parent process's cwd.
   */
  cwd?: string;

  /**
   * Model to use for the session → --model
   * Accepts a ModelLevel preset or any string model identifier.
   */
  model?: ModelLevel | (string & {});

  /**
   * Maximum number of agent loop cycles.
   *
   * Note: `--max-turns` only works with `--print` mode in qodercli, NOT with
   * streaming mode. This option is currently tracked but not passed as a CLI flag.
   * The SDK will track turns internally and terminate when the limit is reached.
   */
  maxTurns?: number;

  /**
   * Permission mode for the session.
   * - `'default'` — Standard permission behavior
   * - `'yolo'` — Bypass all permission checks (→ --dangerously-skip-permissions / --yolo)
   * - `'bypassPermissions'` — Same as `'yolo'` (Claude SDK compatibility)
   * - `'acceptEdits'` / `'plan'` / `'dontAsk'` — Forward-compat; may not be supported by qodercli yet
   */
  permissionMode?: PermissionMode;

  /**
   * Resume a conversation by session ID → --resume <session_id>
   * Mutually exclusive with `continue`.
   */
  resume?: string;

  /**
   * Continue the most recent conversation in the working directory → --continue
   * Mutually exclusive with `resume`.
   */
  continue?: boolean;

  /**
   * List of tool names that are allowed → --allowed-tools
   * These tools will execute automatically without asking for approval.
   */
  allowedTools?: string[];

  /**
   * List of tool names that are disallowed → --disallowed-tools
   * These tools will be removed from the model's context.
   */
  disallowedTools?: string[];

  /**
   * Include partial (streaming) messages in the output → --include-partial-messages
   *
   * When true, the SDK yields `QoderStreamEvent` messages as the model
   * generates content, not just the final complete assistant messages.
   */
  includePartialMessages?: boolean;

  /**
   * Max tokens for model output response → --max-output-tokens
   * Choices: "16k", "32k"
   */
  maxOutputTokens?: "16k" | "32k";

  /**
   * Programmatically define custom subagents → --agents
   * Keys are agent names, values are agent definitions.
   * Serialized as a JSON string when passed to qodercli.
   */
  agents?: Record<string, AgentDefinition>;

  /**
   * File attachments to include with the prompt → --attachment
   * Array of file paths (can be images, etc.).
   */
  attachments?: string[];

  /**
   * System prompt for the session.
   *
   * Matches the Claude Agent SDK `systemPrompt` option shape.
   * - `string` — Use a custom system prompt
   *
   * → Maps to --system-prompt CLI flag.
   */
  systemPrompt?: string;

  /**
   * When true, allows `permissionMode: "bypassPermissions"` to work.
   * This is a safety gate matching the Claude Agent SDK behavior.
   *
   * → Maps to --dangerously-skip-permissions (combined with permissionMode)
   */
  allowDangerouslySkipPermissions?: boolean;

  /**
   * Load Claude Code configurations (.claude folders, skills, commands, subagents)
   * → --with-claude-config
   */
  withClaudeConfig?: boolean;

  /**
   * Custom permission handler for controlling tool usage.
   *
   * Called before each tool execution to determine if it should be allowed or denied.
   * Mirrors the `canUseTool` callback from `@anthropic-ai/claude-agent-sdk`.
   *
   * @example
   * ```ts
   * canUseTool: async (toolName, input, options) => {
   *   if (toolName === "Bash") return { behavior: "deny", message: "Bash not allowed" };
   *   return { behavior: "allow" };
   * }
   * ```
   */
  canUseTool?: CanUseTool;

  /**
   * Controller for cancelling the query → sends SIGTERM to subprocess.
   * When aborted, the query will stop and clean up resources.
   */
  abortController?: AbortController;

  /**
   * Custom path to qodercli binary.
   * Default: "qodercli" resolved via PATH.
   */
  pathToQodercli?: string;

  /**
   * Environment variables to pass to the qodercli process.
   * Defaults to `process.env`.
   *
   * Note: If provided, this REPLACES process.env entirely (same behavior as
   * @anthropic-ai/claude-agent-sdk). The SDK will auto-inject
   * `QODER_ENTRYPOINT=sdk-ts` if not already present.
   */
  env?: { [envVar: string]: string | undefined };
};

// ---------------------------------------------------------------------------
// Query — the AsyncGenerator returned by query()
// ---------------------------------------------------------------------------

export interface Query extends AsyncGenerator<QoderMessage, void, undefined> {
  /** Kill the qodercli subprocess immediately. */
  close(): void;
  /** Send SIGINT to the subprocess (interrupt current operation). */
  interrupt(): Promise<void>;
  /**
   * Change the permission mode for the current session.
   * Only available in streaming input mode.
   *
   * Sends a `control_request` with `subtype: "set_permission_mode"` to qodercli.
   *
   * @param mode - The new permission mode to set
   */
  setPermissionMode(mode: PermissionMode): Promise<void>;
  /**
   * Change the model used for subsequent responses.
   * Only available in streaming input mode.
   *
   * Sends a `control_request` with `subtype: "set_model"` to qodercli.
   *
   * @param model - The model identifier to use, or undefined to use the default
   */
  setModel(model?: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Session info (from *-session.json filesystem reads)
// ---------------------------------------------------------------------------

export type QoderSessionInfo = {
  sessionId: string;
  parentSessionId: string;
  title: string;
  workingDir: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  promptTokens: number;
  completionTokens: number;
  cost: number;
  totalPromptTokens: number;
  totalCompletedTokens: number;
  totalCachedTokens: number;
  totalModelCallTimes: number;
  totalToolCallTimes: number;
  contextUsageRatio: number;

  // --- Claude Agent SDK compatibility aliases (SDKSessionInfo) ---

  /**
   * Display title for the session (alias for `title`).
   * Mirrors `SDKSessionInfo.summary` from `@anthropic-ai/claude-agent-sdk`.
   */
  summary: string;
  /**
   * Last modified time in milliseconds since epoch (alias for `updatedAt`).
   * Mirrors `SDKSessionInfo.lastModified`.
   */
  lastModified: number;
  /**
   * Session file size in bytes.
   * Mirrors `SDKSessionInfo.fileSize`.
   * Always `0` — qodercli session metadata does not include file size.
   */
  fileSize: number;
  /**
   * Working directory for the session (alias for `workingDir`).
   * Mirrors `SDKSessionInfo.cwd`.
   */
  cwd?: string;
  /**
   * Git branch at the end of the session.
   * Mirrors `SDKSessionInfo.gitBranch`.
   * Always `undefined` — qodercli session metadata does not include git branch.
   */
  gitBranch?: string;
  /**
   * User-set session title via /rename.
   * Mirrors `SDKSessionInfo.customTitle`.
   * Always `undefined` — qodercli session metadata does not distinguish custom titles.
   */
  customTitle?: string;
  /**
   * First meaningful user prompt in the session.
   * Mirrors `SDKSessionInfo.firstPrompt`.
   * Always `undefined` — qodercli session metadata does not include first prompt.
   */
  firstPrompt?: string;
};

/**
 * Raw JSON shape of *-session.json files on disk.
 */
export type RawSessionJson = {
  id: string;
  parent_session_id: string;
  title: string;
  message_count: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost: number;
  created_at: number;
  updated_at: number;
  working_dir: string;
  quest: boolean;
  total_prompt_tokens: number;
  total_completed_tokens: number;
  total_cached_tokens: number;
  total_model_call_times: number;
  total_tool_call_times: number;
  context_usage_ratio: number;
};

// ---------------------------------------------------------------------------
// Session messages (from *.jsonl transcript files)
// ---------------------------------------------------------------------------

export type QoderSessionMessage = {
  uuid: string;
  parentUuid: string;
  isSidechain: boolean;
  userType: string;
  cwd: string;
  sessionId: string;
  version: string;
  agentId: string;
  type: "user" | "assistant" | "system";
  subtype?: string;
  timestamp: string;
  isMeta: boolean;
  message?: {
    role: string;
    content: ContentBlock[] | string;
    id: string;
    usage?: UsageInfo;
  };
  /** Present on tool_result messages */
  toolUseResult?: Record<string, unknown>;
  /** Present on system error messages */
  level?: string;
  cause?: string;
  error?: Record<string, unknown>;

  // --- Claude Agent SDK compatibility aliases (SessionMessage) ---

  /**
   * Session ID in snake_case (alias for `sessionId`).
   * Mirrors `SessionMessage.session_id` from `@anthropic-ai/claude-agent-sdk`.
   */
  session_id: string;
  /**
   * Parent tool use ID.
   * Mirrors `SessionMessage.parent_tool_use_id` from `@anthropic-ai/claude-agent-sdk`.
   * Mapped from `parentUuid` — always `null` (qodercli uses parentUuid for message chaining,
   * not tool_use linking; included for API shape compatibility).
   */
  parent_tool_use_id: string | null;
};

// ---------------------------------------------------------------------------
// Options for session listing / reading
// ---------------------------------------------------------------------------

export type ListSessionsOptions = {
  /** Filter sessions by working directory */
  dir?: string;
  /** Custom config directory (default: ~/.qoder) */
  configDir?: string;
  /** Maximum number of sessions to return. */
  limit?: number;
  /**
   * When `dir` is provided and the directory is inside a git repository,
   * include sessions from all git worktree paths. Defaults to `true`.
   */
  includeWorktrees?: boolean;
};

export type GetSessionMessagesOptions = {
  /** Custom config directory (default: ~/.qoder) */
  configDir?: string;
  /** Filter by working directory (needed to locate the JSONL file) */
  dir?: string;
  /** Maximum number of messages to return. */
  limit?: number;
  /** Number of messages to skip from the start. */
  offset?: number;
};

// ---------------------------------------------------------------------------
// Claude Agent SDK compatibility aliases
//
// These allow qoder-anywhere to import types by their original Claude SDK
// names without renaming every import across the codebase.
// ---------------------------------------------------------------------------

/** @alias QoderMessage — Claude SDK compatible name */
export type SDKMessage = QoderMessage;

/** @alias QoderAssistantMessage — Claude SDK compatible name */
export type SDKAssistantMessage = QoderAssistantMessage;

/** @alias QoderUserEchoMessage — Claude SDK compatible name (user echo / tool result messages) */
export type SDKUserMessage = QoderUserEchoMessage;

/** @alias QoderUserMessageReplay — Claude SDK compatible name */
export type SDKUserMessageReplay = QoderUserMessageReplay;
