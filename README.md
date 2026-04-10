# Qoder Anywhere

Qoder in your browser.

Qoder Anywhere is a full-stack web application that lets you manage and interact with [Qoder](https://qoder.com) (qodercli) agent sessions from any browser. It supports multi-session, multi-project, and multi-machine orchestration, with a complete set of features including conversational UI, tool approval, and terminal emulation.

## Why?

Qoder is natively a CLI tool that runs in a local terminal. Qoder Anywhere addresses several limitations:

- **Remote access** — Use Qoder from any device's browser, not just a local terminal
- **Multi-session management** — Run and switch between multiple Qoder sessions, organized by project
- **Multi-machine orchestration** — Control Qoder instances across multiple remote machines from a single web dashboard via the Hub-Node architecture
- **Rich UI** — Markdown rendering, tool call visualization, Todo panel, subagent tracking, and more

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                     Browser (React)                      │
│  Chat UI · Tool Approval · Todo Panel · Terminal         │
└────────────────────────┬────────────────────────────────┘
                         │ WebSocket + REST API
┌────────────────────────▼────────────────────────────────┐
│                    Express Server                        │
│  SessionManager · MessageQueue · TerminalManager         │
└────────────────────────┬────────────────────────────────┘
                         │ qoder-sdk (NDJSON stdio)
┌────────────────────────▼────────────────────────────────┐
│                      qodercli Process                    │
│  Code Generation · Tool Calls · File Edits · Commands    │
└─────────────────────────────────────────────────────────┘
```

### Project Structure

```
qoder-anywhere/
├── packages/
│   ├── qoder-sdk/  # TypeScript SDK that spawns qodercli and streams NDJSON messages
│   ├── shared/     # Shared TypeScript type definitions (WS protocol, API interfaces)
│   ├── server/     # Express + WebSocket backend server
│   └── web/        # React + Vite frontend application
├── tests/e2e/      # End-to-end tests
└── docs/           # Documentation
```

This is an npm workspaces monorepo, fully written in TypeScript (ESM).

### Operating Modes

#### 1. Standalone (default)

The simplest way to run. The server runs locally and manages Qoder sessions directly:

```
qoder-anywhere
```

#### 2. Hub Mode

Acts as a central coordination server — does not run Qoder itself, but proxies requests to connected Nodes:

```
qoder-anywhere --hub
```

#### 3. Node Mode

Connects to a Hub, runs Qoder locally and accepts dispatched requests:

```
qoder-anywhere --connect <hub-url> --access-code <code>
```

**Hub-Node Architecture:**

```
┌──────────┐       ┌───────────────────┐       ┌──────────┐
│  Browser  │◄─────►│    Hub Server      │◄─────►│  Node A  │
└──────────┘       │  (Proxy/Aggregate) │       └──────────┘
                   │                    │◄─────►┌──────────┐
                   └───────────────────┘       │  Node B  │
                                               └──────────┘
```

Hub and Node communicate over a single persistent WebSocket connection, authenticated via HMAC-SHA256 challenge-response, multiplexing REST proxying, WS proxying, and sync events on the same link.

### How It Works

1. **Streaming input mode** — A `MessageQueue` (implementing `AsyncIterable`) feeds into the SDK's `query()`, keeping the qodercli process alive across multiple conversational turns
2. **Zero-translation SDK passthrough** — SDK messages are forwarded verbatim to the frontend as `WSSdkMessage`, avoiding an additional protocol translation layer
3. **Message caching & pruning** — Each session maintains a full message cache; new WebSocket clients receive a full history replay on connect. Intermediate stream events are automatically pruned when finalized messages arrive
4. **Session lifecycle** — `ACTIVE` → `IDLE` (awaiting input) → `INACTIVE` (recycled after 5 min idle), with the ability to reactivate at any time

## Features

| Feature              | Description                                                               |
| -------------------- | ------------------------------------------------------------------------- |
| Web Chat UI          | Send messages and view streaming Qoder responses with Markdown rendering  |
| Multi-session        | Create, switch between, stop, and resume multiple Qoder sessions          |
| Project Organization | Sessions automatically grouped by working directory (cwd)                 |
| Tool Approval        | Tool calls surface for user approval/denial in non-bypass modes           |
| Permission Modes     | Multiple modes including Default / Accept Edits / Plan / YOLO             |
| Interactive Q&A      | AskUserQuestion prompts from Qoder displayed in the UI                    |
| Todo Panel           | Tracks Qoder's TodoWrite calls with task status display                   |
| Subagent Tracking    | Nested Agent tool calls shown in collapsible blocks                       |
| Terminal Emulator    | Full PTY terminal in the browser via node-pty + xterm.js                  |
| Image Support        | Attach base64 images to messages                                          |
| Authentication       | Token + signed cookie auth with rate limiting                             |
| Hub-Node             | Multi-machine orchestration from a single dashboard                       |

## Getting Started

### Prerequisites

- **Node.js** >= 20
- **qodercli** installed and available on `PATH` (Qoder Anywhere spawns it as a subprocess)
- C++ build toolchain (required for compiling the `node-pty` native module)

### Installation

```bash
git clone https://github.com/mjm114514/qoder-anywhere.git
cd qoder-anywhere
npm install
```

### Development

```bash
npm run dev
```

This starts concurrently:

- Backend server (port 3001, with hot reload via tsx)
- Vite dev server (with HMR, proxying API requests to port 3001)

### Production

```bash
# Build all packages (qoder-sdk → shared → server → web)
npm run build

# Start the server (serves both the API and the SPA)
npm run start
```

Then open `http://localhost:3001` in your browser.

### Authentication

On first run, the server generates a 128-bit auth token saved to `~/.qoder-anywhere/auth-token` and displayed in the terminal. Enter this token on the browser login page. The session cookie is valid for 24 hours.

To disable authentication:

```bash
qoder-anywhere --no-auth
```

To refresh the token:

```bash
qoder-anywhere --refresh-token
```

## CLI Reference

```
Usage: qoder-anywhere [options]

Options:
  -p, --port <port>              Port to listen on (default: 3001)
      --no-auth                  Disable authentication
      --hub                      Start in hub mode
      --connect <hub-url>        Connect to a hub server
      --access-code <code>       Access code for hub connection
      --refresh-token            Refresh the auth token and exit
  -h, --help                     Show help message
```

## Development

```bash
# Run end-to-end tests
npm run test

# Lint check
npm run lint

# Auto-format
npm run format
```

## Tech Stack

- **Frontend**: React 19 + Vite 6 + react-markdown + xterm.js
- **Backend**: Express 5 + WebSocket (ws) + node-pty
- **Agent SDK**: qoder-sdk (in-tree, spawns qodercli via NDJSON stdio protocol)
- **Language**: TypeScript (ESM)
- **Monorepo**: npm workspaces
- **Testing**: Vitest (E2E)
- **Code Style**: ESLint 9 + Prettier

## License

MIT
