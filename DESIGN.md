# LGTM Anywhere - System Design

## 系统总览

```
┌─────────────────────────────────────────────────────────────┐
│                      External Clients                       │
│              (Web UI / CLI / CI/CD / 其他服务)                │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTP + WebSocket
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                     Express Server                          │
│  ┌───────────────┐  ┌──────────────────┐  ┌─────────────┐  │
│  │ Project Routes │  │  Session Routes  │  │  WS Handler │  │
│  └───────┬───────┘  └────────┬─────────┘  └──────┬──────┘  │
│          │                   │                    │          │
│          ▼                   ▼                    │          │
│  ┌───────────────┐  ┌──────────────────┐         │          │
│  │ProjectScanner │  │ SessionManager   │◄────────┘          │
│  └───────┬───────┘  └───┬────────┬─────┘                    │
│          │               │        │                          │
└──────────┼───────────────┼────────┼──────────────────────────┘
           │               │        │
           ▼               ▼        ▼
                     ┌───────────┐  ┌──────────────────────────┐
  listSessions({})   │MessageQueue│ │   Claude Agent SDK        │
  聚合 project 列表   │ (per      │ │                            │
                     │  session) │──▶ query() → Query object   │
                     └───────────┘  │   listSessions()          │
                                    │   getSessionMessages()    │
                                    └─────────┬────────────────┘
                                              │
                                              ▼
                                    ┌──────────────────┐
                                    │ Claude Code 子进程 │
                                    │ (per session)     │
                                    └──────────────────┘
```

---

## 组件清单

### 1. `packages/shared` — 共享类型定义

整个 monorepo 的类型合约层，server 和未来的 web client 都依赖它。

```
shared/src/
  types/
    project.ts      ProjectListItem
    session.ts      SessionSummary, SessionDetail, SessionState
    api.ts          所有 request/response 的 body 类型
    sse.ts          SSE event types (legacy)
    ws.ts           WebSocket 消息类型 (client↔server)
  index.ts          统一 re-export
```

**为什么单独拆包**: API 的 request/response 类型和 WS event 类型是 server 与 client 之间的契约，放在 shared 里确保两端类型一致。

---

### 2. `packages/server` — HTTP Server

#### 2.1 Entry & App

```
server/src/
  index.ts          启动 Express，监听端口，attach WebSocket
  app.ts            创建 Express app，挂载中间件和路由
  config.ts         端口、回收策略等配置
```

#### 2.2 Routes

HTTP 路由文件，负责解析请求参数、调用 service、返回响应。路由本身不含业务逻辑。

```
server/src/routes/
  projects.ts       GET /api/projects
  sessions.ts       GET/POST/PUT/DELETE /api/sessions[/:session_id]
```

路由设计原则：
- **`/api/projects`** — 聚合视图，从 `listSessions({})` 按 cwd 聚合
- **`/api/sessions?cwd=...`** — 需要 cwd 的操作通过 query parameter 传递
- **`/api/sessions/:session_id`** — session 级操作不需要 cwd（session_id 全局唯一）

#### 2.3 WebSocket

WebSocket handler，处理 upgrade 请求和消息收发。

```
server/src/ws/
  handler.ts        WS upgrade + message handling
                    路径: /ws/sessions/:session_id
```

#### 2.4 Services — 核心业务逻辑

```
server/src/services/
  project-scanner.ts    通过 listSessions({}) 聚合 project 列表
  session-manager.ts    管理 session 生命周期（核心组件）
  message-queue.ts      AsyncIterable 消息桥梁
```

---

## 核心组件详解

### MessageQueue

```
                push("写一个 TODO app")
                        │
                        ▼
              ┌──────────────────┐
              │   MessageQueue   │
              │                  │
              │  内部缓冲区:       │
              │  [msg1, msg2...] │
              │                  │
              │  实现 AsyncIterable│
              └────────┬─────────┘
                       │
            for await (const msg of queue)
                       │
                       ▼
                   query() 消费
```

职责：实现 `AsyncIterable<SDKUserMessage>` 接口，作为 `query()` 的 prompt 参数。

- `push(content)` — 外部写入用户消息
- `[Symbol.asyncIterator]` — SDK 内部消费，无消息时阻塞等待
- `close()` — 关闭队列，导致 `query()` 的 generator 退出，子进程终止

这是保持 session 存活的关键：只要 queue 不 close，子进程就一直运行。

---

### SessionManager

系统的核心组件。管理所有活跃 session 的创建、消息投递、回收。

```
SessionManager
│
├── activeSessions: Map<sessionId, ActiveSession>
│     │
│     ├── sessionId-1 ──▶ { query, messageQueue, abortController, state, wsClients, ... }
│     ├── sessionId-2 ──▶ { ... }
│     └── sessionId-N ──▶ { ... }
│
├── createSession(cwd, options)
│     创建 MessageQueue → query(prompt=queue) → 等待 init → 注册到 Map → 启动 consumeLoop
│
├── sendMessage(sessionId, message, cwd)
│     查 Map → 不存在则 reactivateSession → messageQueue.push(message)
│
├── reactivateSession(sessionId, cwd)
│     创建 MessageQueue → query(prompt=queue, resume=sessionId) → 启动 consumeLoop
│
├── stopSession(sessionId)
│     关闭 WS → messageQueue.close() → query.close() → 从 Map 移除
│
└── recycle()   (定时器驱动)
      遍历 Map → 找 state=idle 且超时的 → stopSession
```

**关于 consumeLoop**: 每个 ActiveSession 都有一个后台运行的 async 循环，持续从 `Query` generator 读取 `SDKMessage` 并广播给所有 WebSocket 客户端。收到 `result` 时标记 state=idle 但**不退出循环**，等待 MessageQueue 产出下一条消息。

---

### Session 生命周期

```
  POST /sessions?cwd=...   WS: {type:"message"}        idle 5min
  (首条消息)                 (追加消息)                   (自动回收)
       │                        │                          │
       ▼                        ▼                          ▼
  ┌─────────┐  result    ┌─────────┐  超时/DELETE   ┌──────────┐
  │ ACTIVE  │ ────────▶  │  IDLE   │ ────────────▶  │ INACTIVE │
  │         │            │         │                │          │
  │ 有子进程  │  ◀────────  │ 有子进程  │  ◀── resume ──  │ 无子进程   │
  │ 有输出   │  push新消息  │ 等待输入  │   reactivate   │ 仅JSONL  │
  └─────────┘            └─────────┘                └──────────┘
```

| 状态 | 内存中有 Query? | 子进程? | 触发条件 |
|------|:---:|:---:|------|
| **ACTIVE** | 是 | 运行中 | 新建 session 或推入消息 |
| **IDLE** | 是 | 运行中 | 收到 `result`（Claude 完成本轮） |
| **INACTIVE** | 否 | 无 | idle 超时 / DELETE / server 重启 |

回收策略：仅按 idle 超时回收（默认 5 分钟）。不限制活跃 session 数量，不限制单 session 存活时间。

---

### WebSocket 广播机制

```
  Client A ───WS────┐
                     │
  Client B ───WS────┤    consumeLoop
                     │        │
  Client C ───WS────┘        │
       ▲                     │ for await (msg of query)
       │                     │
       │     broadcast       ▼
       └──────────────── SDKMessage
                              │
                              ▼
                         转换为 WS event
                         {event, data} JSON
```

一个 session 可以被多个 WebSocket 客户端同时订阅。`consumeLoop` 从 `Query` generator 读到消息后广播给 `wsClients` Set 中所有连接。

客户端断开时从 Set 中移除。Set 为空不影响 session 生命周期（session 仍处于 ACTIVE/IDLE）。

---

### ProjectScanner

职责：通过 SDK 的 `listSessions({})` 获取所有 sessions，按 `cwd` 聚合为 project 列表。

```typescript
// 调用 listSessions({}) 获取所有 session
// 按 cwd 分组，统计每组的 session 数量和最新 lastModified
// 返回 ProjectListItem[]，按 lastModified 降序排列
```

不再扫描磁盘目录，不再有有损的路径编码问题。

---

## 数据流

### 新建 Session 并 Chat

```
Client                    Server                      SDK / Claude Code
  │                         │                              │
  │  POST /sessions?cwd=... │                              │
  │  {message: "..."}       │                              │
  │────────────────────────▶│                              │
  │                         │  new MessageQueue()          │
  │                         │  query(prompt=queue, ...)    │
  │                         │─────────────────────────────▶│
  │                         │                              │ 启动子进程
  │                         │◀─────────────────────────────│ system(init)
  │  JSON: {sessionId}      │  queue.push(message)         │
  │◀────────────────────────│                              │
  │                         │                              │
  │  WS connect             │                              │
  │  /ws/sessions/:id       │                              │
  │────────────────────────▶│                              │
  │                         │  wsClients.add(ws)           │
  │                         │                              │ ...处理中...
  │  WS: {event:"assistant"}│◀─────────────────────────────│ assistant msg
  │◀────────────────────────│                              │
  │  WS: {event:"result"}  │◀─────────────────────────────│ result
  │◀────────────────────────│                              │
  │                         │  state → IDLE                │
  │  (保持 WS 连接)          │                              │ (子进程等待)
```

### 向已有 Session 追加消息

```
Client                    Server                         SDK / Claude Code
  │                         │                              │
  │  WS: {type:"message",   │                              │
  │       message:"..."}    │                              │
  │────────────────────────▶│                              │
  │                         │  activeSessions.get(id)      │
  │                         │  ├─ 有: 直接拿到 session       │
  │                         │  └─ 无: 返回 SESSION_INACTIVE │
  │                         │       (需通过 REST reactivate)│
  │                         │                              │
  │                         │  queue.push(message)         │
  │                         │                              │ queue 产出消息
  │                         │                              │ → Claude 开始处理
  │  WS: {event:"assistant"}│◀─────────────────────────────│
  │◀────────────────────────│                              │
  │  WS: {event:"result"}  │◀─────────────────────────────│
  │◀────────────────────────│                              │
```

关键点：对于 IDLE session，追加消息对 client 来说完全透明。对于 INACTIVE session，WS 会返回 SESSION_INACTIVE 错误，client 需通过 REST API 触发 reactivation。

### Idle 回收

```
                    SessionManager                    Claude Code
                         │                              │
  recycle timer fires    │                              │
  (每60秒)               │                              │
                         │  遍历 activeSessions          │
                         │  找到 state=idle              │
                         │  且 now - lastActivity > 5min │
                         │                              │
                         │  messageQueue.close()         │
                         │  query.close() ──────────────▶│ 子进程退出
                         │  activeSessions.delete(id)    │
                         │                              │
                         │  JSONL 文件保留在磁盘           │
```

---

## 目录结构

```
lgtm-anywhere/
├── package.json                    # npm workspaces 根配置
├── tsconfig.base.json              # 共享 TS 配置
├── API_DESIGN.md                   # API 接口详细规格
├── DESIGN.md                       # 本文档
│
├── packages/
│   ├── shared/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── types/
│   │       │   ├── project.ts
│   │       │   ├── session.ts
│   │       │   ├── api.ts
│   │       │   ├── sse.ts
│   │       │   └── ws.ts
│   │       └── index.ts
│   │
│   └── server/
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts                # 入口 + WS attach
│           ├── app.ts                  # Express app
│           ├── config.ts               # 配置
│           ├── routes/
│           │   ├── projects.ts         # project 路由
│           │   └── sessions.ts         # session 路由
│           ├── services/
│           │   ├── project-scanner.ts  # 通过 SDK 聚合 project 列表
│           │   ├── session-manager.ts  # 核心生命周期管理
│           │   └── message-queue.ts    # AsyncIterable 桥梁
│           └── ws/
│               └── handler.ts          # WebSocket handler
```

---

## 实现顺序

```
Phase 1: 基础骨架
├── shared types
├── Express app + config
└── ProjectScanner (listSessions 聚合) + GET /projects

Phase 2: Session 读取 (只读)
├── GET /sessions?cwd=... (listSessions)
├── GET /sessions/:id (getSessionMessages)
└── 验证 SDK 读取 API 可用

Phase 3: Session 交互 (核心)
├── MessageQueue
├── SessionManager (create + consumeLoop)
├── POST /sessions?cwd=... (新建, 返回 JSON sessionId)
├── WebSocket handler (消息收发 + 流式广播)
└── WS 广播机制

Phase 4: 管理操作
├── PUT /sessions/:id (改标题/模型)
├── DELETE /sessions/:id (停止)
└── idle 回收定时器

Phase 5: 健壮性
├── 错误处理中间件
├── 连接断开清理
├── graceful shutdown
└── 日志
```
