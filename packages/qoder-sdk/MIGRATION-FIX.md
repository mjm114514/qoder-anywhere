# qoder-sdk Migration Fix Document

> 目标：让 qoder-sdk 完全替代 `@anthropic-ai/claude-agent-sdk` 在 qoder-anywhere 项目中的所有使用。

本文档列出 qoder-sdk 需要修改的每一处，并给出具体的代码修改方案。
修改完成后，项目中所有 `@anthropic-ai/claude-agent-sdk` 的 import 都可以替换为 `qoder-sdk`。

---

## 目录

1. [types.ts — 消息类型扩展](#1-typests--消息类型扩展)
2. [types.ts — QueryOptions 补全](#2-typests--queryoptions-补全)
3. [types.ts — 兼容类型别名导出](#3-typests--兼容类型别名导出)
4. [transport.ts — buildArgs() 映射补全](#4-transportts--buildargs-映射补全)
5. [index.ts — 导出新增类型](#5-indexts--导出新增类型)
6. [qoder-anywhere 侧的改动](#6-qoder-anywhere-侧的改动)

---

## 1. types.ts — 消息类型扩展

### 1.1 给所有消息加 `parent_tool_use_id` 字段

项目中 `useSessionSocket.ts` 大量依赖 `parent_tool_use_id` 来区分主 agent 和 subagent 消息。
qodercli 输出的 assistant / user / stream_event 消息都可能带 `parent_tool_use_id`。

**修改 `QoderAssistantMessage`：**

```ts
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
```

**修改 `QoderUserEchoMessage`：**

```ts
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
```

> `tool_use_result` 字段：session-manager.ts:77 用 `userMsg.tool_use_result !== undefined` 来区分 tool result 和普通 user 消息。

**修改 `QoderStreamEvent`：**

```ts
export type QoderStreamEvent = {
  type: "stream_event";
  session_id: string;
  uuid: string;
  /** Tool use ID of the parent agent, if this is a subagent stream event. */
  parent_tool_use_id?: string | null;
  event: StreamEventData;
};
```

### 1.2 扩展 `QoderSystemMessage` 为 union（多种 subtype）

当前 `QoderSystemMessage` 只有 `subtype: "init"`。项目中用到以下 subtypes：

- `"init"` — 初始化消息
- `"status"` — 状态更新（含 permissionMode 同步）
- `"task_started"` — subagent 后台任务启动
- `"task_progress"` — subagent 任务进度
- `"task_notification"` — subagent 任务完成/失败

**替换为：**

```ts
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

export type QoderSystemStatusMessage = {
  type: "system";
  subtype: "status";
  session_id: string;
  uuid: string;
  /** Current permission mode (synced from CLI, e.g. after ExitPlanMode). */
  permissionMode?: string;
  [key: string]: unknown;
};

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

/** Union of all system message subtypes. */
export type QoderSystemMessage =
  | QoderSystemInitMessage
  | QoderSystemStatusMessage
  | QoderTaskStartedMessage
  | QoderTaskProgressMessage
  | QoderTaskNotificationMessage;
```

### 1.3 新增 `QoderToolProgressMessage` 类型

session-manager.ts:73 对 `message.type === "tool_progress"` 做了 switch case。

```ts
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
```

### 1.4 更新 `QoderMessage` union

```ts
export type QoderMessage =
  | QoderSystemMessage
  | QoderAssistantMessage
  | QoderUserEchoMessage
  | QoderStreamEvent
  | QoderResultMessage
  | QoderToolProgressMessage;
```

### 1.5 新增 `QoderUserMessageReplay` 类型

session-manager.ts:77 用 `SDKUserMessageReplay` 做联合类型判断。

```ts
/**
 * Replayed user message from a resumed session.
 * Structurally identical to QoderUserEchoMessage, with isReplay marker.
 */
export type QoderUserMessageReplay = QoderUserEchoMessage & {
  isReplay?: true;
};
```

---

## 2. types.ts — QueryOptions 补全

### 2.1 添加 `allowDangerouslySkipPermissions` 字段

session-manager.ts:233 和 339 都用了这个字段。

```ts
export type QueryOptions = {
  // ... 现有字段 ...

  /**
   * When true, allows `permissionMode: "bypassPermissions"` to work.
   * This is a safety gate matching the Claude Agent SDK behavior.
   *
   * → Maps to --dangerously-skip-permissions (combined with permissionMode)
   */
  allowDangerouslySkipPermissions?: boolean;

  // ... 其余字段不变 ...
};
```

### 2.2 `systemPrompt` 标记为待实现（已有字段，需在 transport 中映射）

字段已存在于 `QueryOptions`，但需要在 `buildArgs()` 中实现映射。见 [第 4 节](#4-transportts--buildargs-映射补全)。

### 2.3 `maxTurns` 标记为待实现

字段已存在于 `QueryOptions`，但未实际传递或内部追踪。见 [第 4 节](#4-transportts--buildargs-映射补全)。

---

## 3. types.ts — 兼容类型别名导出

项目中所有 import 用的是 Claude SDK 的类型名。为了减少 qoder-anywhere 侧改动量，提供兼容别名：

```ts
// ---------------------------------------------------------------------------
// Claude Agent SDK compatibility aliases
// ---------------------------------------------------------------------------

/** @alias QoderMessage — Claude SDK 兼容名 */
export type SDKMessage = QoderMessage;

/** @alias QoderAssistantMessage — Claude SDK 兼容名 */
export type SDKAssistantMessage = QoderAssistantMessage;

/** @alias QoderUserEchoMessage — Claude SDK 兼容名（作为 SDKUserMessage 的 echo 部分）*/
export type SDKUserMessage = QoderUserEchoMessage;

/** @alias QoderUserMessageReplay — Claude SDK 兼容名 */
export type SDKUserMessageReplay = QoderUserMessageReplay;
```

> 这样项目中 `import type { SDKMessage, SDKAssistantMessage, SDKUserMessage, SDKUserMessageReplay } from "qoder-sdk"` 无需改名即可编译。

---

## 4. transport.ts — buildArgs() 映射补全

### 4.1 `allowDangerouslySkipPermissions` 逻辑

当前 `buildArgs()` 只检查 `permissionMode`。需要加上 `allowDangerouslySkipPermissions` 的支持：

```ts
// 替换现有的 --dangerously-skip-permissions 逻辑：
if (
  opts.permissionMode === "yolo" ||
  opts.permissionMode === "bypassPermissions" ||
  opts.allowDangerouslySkipPermissions
) {
  args.push("--dangerously-skip-permissions");
}
```

### 4.2 `systemPrompt` 映射

qodercli 如果支持 `--system-prompt` 或环境变量传递，则加入映射：

```ts
// --system-prompt (if supported by qodercli)
if (opts.systemPrompt) {
  args.push("--system-prompt", opts.systemPrompt);
}
```

> ⚠️ 如果 qodercli 不支持 `--system-prompt` flag，可以通过环境变量传递：
> ```ts
> if (opts.systemPrompt) {
>   env.QODER_SYSTEM_PROMPT = opts.systemPrompt;
> }
> ```
> 需要确认 qodercli 支持哪种方式。

### 4.3 `maxTurns` 映射

qodercli streaming 模式下 `--max-turns` 不工作，需要 **SDK 内部追踪**。

在 `query.ts` 的 `generate()` 函数中添加内部计数：

```ts
async function* generate(): AsyncGenerator<QoderMessage, void, undefined> {
  transport.start();

  let turnCount = 0;
  const maxTurns = options.maxTurns;

  // ... 现有的 inputPipe 逻辑 ...

  try {
    for await (const message of transport.readMessages()) {
      yield message;

      // Track turns: each "result" message completes a turn
      if (message.type === "result") {
        turnCount++;
        if (isOneShot) break;
        if (maxTurns && turnCount >= maxTurns) {
          transport.kill();
          break;
        }
      }
    }
  } finally {
    // ... 现有清理逻辑 ...
  }
}
```

---

## 5. index.ts — 导出新增类型

在 `index.ts` 的类型导出块中添加：

```ts
export type {
  // ... 现有导出 ...

  // 新增 system message 子类型
  QoderSystemInitMessage,
  QoderSystemStatusMessage,
  QoderTaskStartedMessage,
  QoderTaskProgressMessage,
  QoderTaskNotificationMessage,

  // 新增消息类型
  QoderToolProgressMessage,
  QoderUserMessageReplay,

  // Claude SDK 兼容别名
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKUserMessageReplay,
} from "./types.js";
```

---

## 6. qoder-anywhere 侧的改动

qoder-sdk 修改完成后，项目侧需要以下改动：

### 6.1 替换 package.json 依赖

**packages/server/package.json：**
```diff
- "@anthropic-ai/claude-agent-sdk": "^0.2.71",
+ "qoder-sdk": "*",
```

**packages/shared/package.json：**
```diff
- "@anthropic-ai/claude-agent-sdk": "^0.2.71"
+ "qoder-sdk": "*"
```

**packages/web/package.json (devDependencies)：**
```diff
- "@anthropic-ai/claude-agent-sdk": "^0.2.71",
+ "qoder-sdk": "*",
```

### 6.2 替换 import 路径（6 个文件）

所有 `from "@anthropic-ai/claude-agent-sdk"` 改为 `from "qoder-sdk"`：

| 文件 | 改动 |
|------|------|
| `packages/server/src/services/session-manager.ts` | 改 import 路径 |
| `packages/server/src/services/message-queue.ts` | 改 import 路径 |
| `packages/server/src/routes/sessions.ts` | 改 import 路径 |
| `packages/server/src/ws/handler.ts` | 改 import 路径 |
| `packages/server/src/services/project-scanner.ts` | 改 import 路径 |
| `packages/shared/src/types/ws.ts` | 改 import 路径 |
| `packages/web/src/hooks/useSessionSocket.ts` | 改 import 路径 |

因为我们在 qoder-sdk 中提供了 `SDKMessage` / `SDKAssistantMessage` / `SDKUserMessage` / `SDKUserMessageReplay` 兼容别名，**import 语句只需改路径，不需要改类型名**。

### 6.3 server/src/services/message-queue.ts 结构兼容

当前构造的消息结构是：
```ts
const msg: SDKUserMessage = {
  type: "user",
  session_id: "",
  message: { role: "user", content: ... },
  parent_tool_use_id: null,
};
```

qoder-sdk 的 `QoderUserMessage`（现在别名为 `SDKUserMessage`）也有这些字段。
但注意 `SDKUserMessage` 现在是 `QoderUserEchoMessage` 的别名，而项目的 MessageQueue 实际上构造的是 **输入消息** (`QoderUserMessage`)，不是 echo 消息。

**推荐改法：** 将 MessageQueue 的类型改为 `QoderUserMessage`：

```diff
- import type { SDKUserMessage } from "qoder-sdk";
+ import type { QoderUserMessage } from "qoder-sdk";

- private messages: SDKUserMessage[] = [];
- private waiting: ((msg: SDKUserMessage) => void) | null = null;
+ private messages: QoderUserMessage[] = [];
+ private waiting: ((msg: QoderUserMessage) => void) | null = null;

- const msg: SDKUserMessage = {
+ const msg: QoderUserMessage = {
```

> 或者在 types.ts 中让 `SDKUserMessage` 别名同时也能覆盖输入消息：
> 更简单的做法是不做这个改动，继续用 `SDKUserMessage`，因为结构上是兼容的。

### 6.4 session-manager.ts 中 `permissionMode` 字段名

当前代码访问 `message.permissionMode`（camelCase），但 qodercli init 消息用的是 `permission_mode`（snake_case）。

两种方案：

**方案 A（推荐）：** 在 `QoderSystemInitMessage` 中同时保留两个字段（已在 1.2 中定义了 `permissionMode?: string`）。

**方案 B：** 在 session-manager.ts 中两个都检查：
```ts
const initPerm = (message as any).permissionMode ?? (message as any).permission_mode;
```

---

## 修改清单总结

| # | 文件 | 修改内容 | 优先级 |
|---|------|---------|--------|
| 1 | `src/types.ts` | `QoderAssistantMessage` 加 `parent_tool_use_id` | P0 |
| 2 | `src/types.ts` | `QoderUserEchoMessage` 加 `parent_tool_use_id` + `tool_use_result` | P0 |
| 3 | `src/types.ts` | `QoderStreamEvent` 加 `parent_tool_use_id` | P0 |
| 4 | `src/types.ts` | `QoderSystemMessage` 拆分为 5 种 subtype union | P0 |
| 5 | `src/types.ts` | 新增 `QoderToolProgressMessage` | P0 |
| 6 | `src/types.ts` | 更新 `QoderMessage` union | P0 |
| 7 | `src/types.ts` | 新增 `QoderUserMessageReplay` | P1 |
| 8 | `src/types.ts` | `QueryOptions` 加 `allowDangerouslySkipPermissions` | P0 |
| 9 | `src/types.ts` | 添加 `SDKMessage` / `SDKAssistantMessage` / `SDKUserMessage` / `SDKUserMessageReplay` 兼容别名 | P0 |
| 10 | `src/transport.ts` | `buildArgs()` 加 `allowDangerouslySkipPermissions` 逻辑 | P0 |
| 11 | `src/transport.ts` | `buildArgs()` 映射 `systemPrompt` | P1 |
| 12 | `src/query.ts` | `maxTurns` 内部追踪逻辑 | P1 |
| 13 | `src/index.ts` | 导出新增类型和兼容别名 | P0 |

---

## 验证方式

修改完成后执行：

```bash
# 1. 构建 qoder-sdk
npm run build -w packages/qoder-sdk

# 2. 替换所有 import 路径后构建全项目
npm run build

# 3. 确认没有 TypeScript 类型错误
npx tsc --noEmit -p packages/server/tsconfig.json
npx tsc --noEmit -p packages/shared/tsconfig.json
```
