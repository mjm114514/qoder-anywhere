# LGTM Anywhere - API Design Document

## Overview

一个 HTTP Server，通过 `@anthropic-ai/claude-agent-sdk` 暴露本地 Claude Code 能力，让外部系统可以管理 projects、sessions，并通过 WebSocket 实时接收 Claude 的流式响应。

## 核心概念

| 概念 | 说明 |
|------|------|
| **Project** | 对应一个本地目录（CWD），是 sessions 的逻辑分组，通过 `listSessions()` 聚合得到 |
| **Session** | 一次对话，对应一个 JSONL 文件。可以是已完成的历史 session，也可以是正在活跃的 session |
| **Active Session** | server 内存中持有 `Query` 对象的 session，底层对应一个 Claude Code 子进程 |

### CWD 传递方式

CWD（工作目录路径）通过 **query parameter** 传递，使用标准 URL 编码：

```
GET /api/sessions?cwd=%2FUsers%2Fjiamingmao%2Frepos%2Fmy-project
POST /api/sessions?cwd=%2FUsers%2Fjiamingmao%2Frepos%2Fmy-project
```

对于 session 级别的操作（GET/PUT/DELETE `/api/sessions/:session_id`），不需要 cwd —— session_id 本身是全局唯一的。

---

## 技术选型

- **Runtime**: Node.js + TypeScript (ESM)
- **Framework**: Express.js
- **SDK**: `@anthropic-ai/claude-agent-sdk` (^0.2.71)
  - `listSessions({})` — 列出所有 sessions（不传 dir）
  - `listSessions({ dir })` — 列出指定目录下的 sessions
  - `getSessionMessages()` — 读取 session 消息历史
  - `query()` — 创建/恢复 session，返回 `Query` async generator
- **Streaming**: WebSocket (`ws`)

---

## Session 生命周期

这是整个设计中最关键的部分。`Query` 对象代表一个 Claude Code 子进程，它的生命周期决定了 session 的行为模式。

### 两种输入模式

SDK 提供两种使用 `query()` 的方式，它们的生命周期完全不同：

| | Single Message Mode | Streaming Input Mode |
|---|---|---|
| **prompt 参数** | `string` | `AsyncIterable<SDKUserMessage>` |
| **生命周期** | Claude 处理完 → 发出 `result` → generator 结束 → **进程退出** | 只要 AsyncIterable 不 close，**进程一直活着** |
| **多轮对话** | 每轮都要新建 `query()`，通过 `resume` 恢复上下文 | 向 AsyncIterable 推送新消息即可，进程不重启 |
| **资源消耗** | 按需启停，空闲时无进程 | 常驻进程，占内存 |

### 设计决策：统一使用 Streaming Input Mode

**所有 session 都使用 Streaming Input Mode**，原因：

1. **响应更快** — 不需要为每条消息重新启动 Claude Code 子进程
2. **模型一致** — 单一模式，追加消息不需要区分"活跃 vs 历史"两种路径
3. **支持中断** — 可以随时调用 `query.interrupt()`

代价是常驻进程会占用资源，所以需要**自动回收**机制。

### Session 状态机

```
                POST /sessions
                (创建新 session)
                      │
                      ▼
               ┌──────────────┐
               │   ACTIVE     │◄──── WS: {type:"message"}
               │              │      (如果 session 不在内存中，
               │  有 Query 对象  │       用 resume 重新激活)
               │  有子进程运行   │
               └──────┬───────┘
                      │
          ┌───────────┴───────────┐
          ▼                       ▼
      result 消息             DELETE 请求
      (Claude 完成)            (主动关闭)
          │                       │
          ▼                       │
               ┌──────────────┐
               │   IDLE       │
               │              │
               │  Query 仍存活  │
               │  等待新消息    │
               └──────┬───────┘
                      │
              idle 超时到期
              (默认 5 分钟)
                      │
                      ▼
               ┌──────────────┐
               │  INACTIVE    │
               │              │
               │  query.close()│
               │  进程已退出    │
               │  仅 JSONL 存在 │
               └──────────────┘
```

### 状态说明

| 状态 | 内存中有 Query? | 子进程运行? | 说明 |
|------|:---:|:---:|------|
| **ACTIVE** | 是 | 是 | Claude 正在处理消息，有 WS 流在输出 |
| **IDLE** | 是 | 是 | 上一轮对话完成（收到 `result`），Query 进程还活着，等待新消息输入 |
| **INACTIVE** | 否 | 否 | 只有磁盘上的 JSONL 文件，需要 `resume` 才能重新激活 |

### 自动回收策略

```typescript
interface RecyclePolicy {
  // IDLE 状态下多久没有新消息就回收
  idleTimeoutMs: number;        // 默认 5 分钟
}
```

**回收流程**:
1. 定时器每分钟扫描一次 `activeSessions`
2. 对处于 IDLE 且超过 `idleTimeoutMs` 的 session 执行 `query.close()`
3. 从 Map 中移除，子进程退出，JSONL 文件保留

> 不限制最大活跃 session 数，也不限制单 session 存活时间。只按 idle 超时回收。

---

## API Endpoints

### 1. `GET /api/projects`

列出本地所有 Claude Code projects。

**Response** `200 OK`

```json
[
  {
    "cwd": "/Users/jiamingmao/repos/my-project",
    "sessionCount": 12,
    "lastModified": 1709856000000
  }
]
```

**实现**: 调用 `listSessions({})` 获取所有 sessions，按 `cwd` 聚合统计 session 数量和最新修改时间。

---

### 2. `GET /api/sessions?cwd=<url-encoded-cwd>`

列出某个 cwd 下的所有 sessions。

**Query Parameters**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `cwd` | string | 是 | — | 工作目录路径（URL 编码） |
| `limit` | number | 否 | 50 | 返回数量上限 |

**Response** `200 OK`

```json
[
  {
    "sessionId": "6803e0d5-e405-4183-9947-881c33038adb",
    "summary": "Implement authentication module",
    "lastModified": 1709856000000,
    "fileSize": 524288,
    "cwd": "/Users/jiamingmao/repos/my-project",
    "gitBranch": "main",
    "state": "inactive"
  }
]
```

`state` 取值: `"active"` | `"idle"` | `"inactive"`

**实现**: 调用 SDK 的 `listSessions({ dir: cwd, limit })`，合并 `activeSessions` Map 中的状态信息。

---

### 3. `GET /api/sessions/:session_id`

获取某个 session 的详情和消息历史。不需要 cwd 参数。

**Query Parameters**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `limit` | number | 100 | 消息数量上限 |
| `offset` | number | 0 | 跳过前 N 条消息 |

**Response** `200 OK`

```json
{
  "sessionId": "6803e0d5-e405-4183-9947-881c33038adb",
  "summary": "Implement authentication module",
  "lastModified": 1709856000000,
  "state": "idle",
  "messages": [
    {
      "type": "user",
      "uuid": "msg-001",
      "message": { "role": "user", "content": "Help me implement JWT auth" }
    },
    {
      "type": "assistant",
      "uuid": "msg-002",
      "message": {
        "role": "assistant",
        "content": [
          { "type": "text", "text": "I'll help you implement JWT authentication..." }
        ]
      }
    }
  ]
}
```

**实现**: 调用 SDK 的 `getSessionMessages(sessionId, { limit, offset })`。通过 `listSessions({})` 获取 summary 等元信息。

---

### 4. `POST /api/sessions?cwd=<url-encoded-cwd>`

创建一个新 session 并发送第一条消息。返回 JSON（包含 sessionId）。

**Query Parameters**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cwd` | string | 是 | 工作目录路径（URL 编码） |

**Request Body**

```json
{
  "message": "Help me implement a REST API with Express",
  "model": "sonnet",
  "permissionMode": "bypassPermissions",
  "allowedTools": ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
  "systemPrompt": "You are a helpful coding assistant.",
  "maxTurns": 50
}
```

| 字段 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `message` | 是 | string | 用户消息 |
| `model` | 否 | string | 模型名称，默认 SDK 默认值 |
| `permissionMode` | 否 | string | 权限模式，默认 `"bypassPermissions"` |
| `allowedTools` | 否 | string[] | 自动批准的工具列表 |
| `systemPrompt` | 否 | string | 自定义 system prompt |
| `maxTurns` | 否 | number | 最大 agentic turns |

**Response** `200 OK`

```json
{
  "sessionId": "6803e0d5-e405-4183-9947-881c33038adb"
}
```

创建后，客户端通过 WebSocket 连接 `ws://host/ws/sessions/:session_id` 接收流式事件和发送后续消息。

**实现逻辑**:

```typescript
// 1. 创建 MessageQueue（AsyncIterable）
const messageQueue = new MessageQueue();

// 2. 用 streaming input mode 创建 query
const abortController = new AbortController();
const q = query({
  prompt: messageQueue,   // AsyncIterable，不会自动结束
  options: {
    cwd,
    model: body.model,
    permissionMode: body.permissionMode ?? "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    allowedTools: body.allowedTools,
    systemPrompt: body.systemPrompt,
    maxTurns: body.maxTurns,
    abortController,
  },
});

// 3. 等待 init 消息，设置 sessionId，注册到 activeSessions
// 4. 推入第一条用户消息，启动 consumeLoop（后台）
// 5. 返回 { sessionId }
```

---

### 5. `PUT /api/sessions/:session_id`

更新 session 元信息（如自定义标题）或运行时配置。不需要 cwd 参数。

**Request Body**

```json
{
  "title": "Auth Module Implementation",
  "model": "opus"
}
```

| 字段 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `title` | 否 | string | 自定义 session 标题 |
| `model` | 否 | string | 切换模型（仅对活跃/idle session 生效） |

**Response** `200 OK`

```json
{
  "sessionId": "6803e0d5-e405-4183-9947-881c33038adb",
  "title": "Auth Module Implementation",
  "model": "opus"
}
```

**实现**:
- `model` 变更：如果 session 在内存中，调用 `query.setModel(model)`
- `title` 变更：写入 session JSONL 文件

---

### 6. `DELETE /api/sessions/:session_id`

停止一个 session。不需要 cwd 参数。

**Response** `200 OK`

```json
{
  "sessionId": "6803e0d5-e405-4183-9947-881c33038adb",
  "stopped": true,
  "fileDeleted": false
}
```

**实现**:
如果 session 在内存中：
1. 关闭所有 WebSocket 连接
2. 调用 `messageQueue.close()` 结束 AsyncIterable
3. 调用 `query.close()` 终止子进程
4. 从 `activeSessions` Map 中移除

---

## WebSocket 协议

### 连接

```
ws://host/ws/sessions/:session_id
```

客户端通过此 URL 连接指定 session。连接后：
- 服务端将此 WS 客户端加入 session 的广播列表
- 客户端可以发送消息，服务端会广播 Claude 的流式响应
- 一个 session 可以被多个 WS 客户端同时订阅

### 客户端 → 服务端

客户端通过 WebSocket 发送 JSON 消息：

```json
{
  "type": "message",
  "message": "Now add unit tests for the auth module"
}
```

| 字段 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `type` | 是 | `"message"` | 消息类型 |
| `message` | 是 | string | 用户消息内容 |

如果 session 处于 INACTIVE 状态（不在内存中），WS 会返回 `SESSION_INACTIVE` 错误，客户端需要通过 REST API 重新发送消息来触发 reactivation。

如果 session 正在处理消息（ACTIVE），返回 `SESSION_BUSY` 错误。

### 服务端 → 客户端

服务端通过 WebSocket 发送 JSON 消息，格式统一为 `{ event, data }`：

```json
{"event": "init", "data": {"sessionId": "uuid", "cwd": "/path/to/project", "model": "sonnet"}}

{"event": "assistant", "data": {"type": "assistant", "uuid": "msg-002", "message": {...}}}

{"event": "stream_event", "data": {"type": "stream_event", "event": {...}, "parent_tool_use_id": null}}

{"event": "tool_result", "data": {"type": "user", "uuid": "msg-003", "message": {...}, "tool_use_result": {...}}}

{"event": "result", "data": {"subtype": "success", "result": "Done!", "session_id": "uuid", "total_cost_usd": 0.05, "duration_ms": 12000, "num_turns": 3}}

{"event": "tool_progress", "data": {...}}

{"event": "status", "data": {...}}

{"event": "error", "data": {"error": "Something went wrong", "code": "QUERY_ERROR"}}
```

### SDKMessage → WS Event 映射

| SDKMessage.type | event | 说明 |
|-----------------|-------|------|
| `system` (subtype: `init`) | `init` | session 初始化信息 |
| `assistant` | `assistant` | 完整 assistant 消息（含 text/tool_use/thinking blocks） |
| `stream_event` | `stream_event` | 流式 token delta |
| `user` (tool result) | `tool_result` | 工具执行结果 |
| `result` | `result` | 本轮结束（**WS 连接不会关闭**） |
| `tool_progress` | `tool_progress` | 工具执行进度 |
| `status` | `status` | 状态更新 |
| (error caught) | `error` | 错误信息 |

> **注意**: `result` 事件表示 Claude 完成了本轮处理，但 WebSocket 连接**不会关闭**。
> 客户端收到 `result` 后可以继续通过同一个 WS 连接发送新消息。

---

## 内部架构

### MessageQueue

将用户消息推送给 `query()` 的桥梁。实现 `AsyncIterable<SDKUserMessage>`：

```typescript
class MessageQueue {
  private messages: SDKUserMessage[] = [];
  private waiting: ((msg: SDKUserMessage) => void) | null = null;
  private closed = false;

  push(content: string) {
    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content },
    };
    if (this.waiting) {
      this.waiting(msg);
      this.waiting = null;
    } else {
      this.messages.push(msg);
    }
  }

  async *[Symbol.asyncIterator]() {
    while (!this.closed) {
      if (this.messages.length > 0) {
        yield this.messages.shift()!;
      } else {
        yield await new Promise<SDKUserMessage>((resolve) => {
          this.waiting = resolve;
        });
      }
    }
  }

  close() { this.closed = true; }
}
```

这是整个多轮对话的核心：只要 `close()` 没被调用，`query()` 的 async generator 就不会结束，子进程持续运行。

### ActiveSession

```typescript
interface ActiveSession {
  sessionId: string;
  cwd: string;
  query: Query;
  messageQueue: MessageQueue;
  abortController: AbortController;
  state: "active" | "idle";
  model?: string;
  createdAt: number;
  lastActivityAt: number;         // 最后一次消息时间，用于 idle 回收
  wsClients: Set<WebSocket>;
}
```

### SessionManager

```typescript
class SessionManager {
  private activeSessions: Map<string, ActiveSession>;
  private recycleTimer: NodeJS.Timeout;

  constructor() {
    // 每分钟检查一次回收
    this.recycleTimer = setInterval(() => this.recycle(), 60_000);
  }

  // 创建新 session（streaming mode）
  async createSession(cwd: string, options: CreateOptions): Promise<ActiveSession>;

  // 向 session 追加消息（如果 INACTIVE 则先 reactivate）
  async sendMessage(sessionId: string, message: string, cwd: string): Promise<ActiveSession>;

  // 重新激活 INACTIVE session（resume + streaming mode）
  private async reactivateSession(sessionId: string, cwd: string): Promise<ActiveSession>;

  // 订阅/取消订阅 WebSocket
  subscribeWS(sessionId: string, ws: WebSocket): void;
  unsubscribeWS(sessionId: string, ws: WebSocket): void;

  // 停止 session（close query + remove from map）
  async stopSession(sessionId: string): Promise<void>;

  // 切换模型
  async setModel(sessionId: string, model: string): Promise<void>;

  // 获取状态
  getState(sessionId: string): "active" | "idle" | "inactive";

  // 定时回收 idle session
  private recycle(): void;
}
```

### 请求处理流程图

```
POST /sessions?cwd=... (新建)              WS: {type:"message"}
       │                                          │
       ▼                                          ▼
  创建 MessageQueue                      activeSessions.has(id)?
  创建 query(prompt=queue)                 ├── YES: 直接拿到 session
  等待 init → 返回 {sessionId}             └── NO: SESSION_INACTIVE 错误
  启动 consumeLoop                                (通过 REST 触发 reactivate)
       │
       │
       ▼
  客户端用 sessionId
  连接 WebSocket
       │
       ▼
  WS 加入 session.wsClients ─────────► 广播 WS events 给所有 clients
```

---

## 项目结构

```
packages/
  shared/src/
    types/
      project.ts          # ProjectListItem
      session.ts           # SessionSummary, SessionDetail, SessionState
      api.ts               # Request/Response types
      sse.ts               # SSE event types (legacy, kept for reference)
      ws.ts                # WebSocket message types (client↔server)
    index.ts

  server/src/
    index.ts               # Entry point, attach WebSocket
    app.ts                 # Express app setup
    config.ts              # 配置（端口、回收策略等）
    routes/
      projects.ts          # GET /api/projects
      sessions.ts          # GET/POST/PUT/DELETE /api/sessions
    services/
      project-scanner.ts   # 通过 listSessions() 聚合 project 列表
      session-manager.ts   # 核心：ActiveSession 管理 + 回收
      message-queue.ts     # MessageQueue（AsyncIterable）
    ws/
      handler.ts           # WebSocket upgrade + message handling
```

---

## 错误处理

### HTTP 错误

所有 HTTP 接口统一错误格式：

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "cwd query parameter is required"
  }
}
```

| HTTP Status | Code | 场景 |
|-------------|------|------|
| 400 | `INVALID_REQUEST` | 缺少必填字段或参数格式错误（如缺少 cwd） |
| 404 | `SESSION_NOT_FOUND` | session_id 对应文件不存在 |
| 500 | `INTERNAL_ERROR` | 其他内部错误 |

### WebSocket 错误

通过 WS 消息返回：

```json
{"event": "error", "data": {"error": "Session is currently processing a message", "code": "SESSION_BUSY"}}
```

| Code | 场景 |
|------|------|
| `INVALID_MESSAGE` | WS 消息不是合法 JSON |
| `INVALID_REQUEST` | 缺少 `message` 字段 |
| `SESSION_BUSY` | session 正在处理消息（state=active） |
| `SESSION_INACTIVE` | session 不在内存中，需通过 REST 重新激活 |
| `SEND_ERROR` | 发送消息时出错 |
| `UNKNOWN_TYPE` | 未知的消息 type |
| `QUERY_ERROR` | SDK query() 执行异常 |
| `SESSION_STOPPED` | session 被停止 |

---

## 客户端使用示例

### 创建新 session

```typescript
// Step 1: 创建 session
const cwd = encodeURIComponent('/Users/me/repos/myapp');
const res = await fetch(`/api/sessions?cwd=${cwd}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: 'Create a REST API' }),
});
const { sessionId } = await res.json();

// Step 2: 连接 WebSocket 接收流式事件
const ws = new WebSocket(`ws://localhost:3001/ws/sessions/${sessionId}`);

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  switch (msg.event) {
    case 'init':
      console.log('Session ready:', msg.data.sessionId);
      break;
    case 'assistant':
      console.log('Assistant:', msg.data);
      break;
    case 'result':
      console.log('Done! Cost:', msg.data.total_cost_usd);
      break;
  }
};
```

### 向已有 session 发送消息

```typescript
// 通过同一个 WebSocket 连接发送后续消息
ws.send(JSON.stringify({
  type: 'message',
  message: 'Now add error handling',
}));
// 事件通过 ws.onmessage 回调接收，格式完全一致
```
