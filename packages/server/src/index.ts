// Allow SDK to spawn Claude Code even when running inside a Claude Code session
delete process.env.CLAUDECODE;

import { createApp } from "./app.js";
import { SessionManager } from "./services/session-manager.js";
import { attachWebSocket } from "./ws/handler.js";
import { config } from "./config.js";

const sessionManager = new SessionManager();
const app = createApp(sessionManager);

const server = app.listen(config.port, () => {
  console.log(`[lgtm-anywhere] Server listening on http://localhost:${config.port}`);
  console.log(`[lgtm-anywhere] WebSocket at ws://localhost:${config.port}/ws/sessions/:session_id`);
});

// Attach WebSocket handler to the same HTTP server
attachWebSocket(server, sessionManager);

// Graceful shutdown
async function shutdown(signal: string) {
  console.log(`\n[${signal}] Shutting down gracefully...`);
  await sessionManager.shutdown();
  server.close(() => {
    console.log("[shutdown] Server closed");
    process.exit(0);
  });
  // Force exit after 10s
  setTimeout(() => {
    console.error("[shutdown] Forced exit");
    process.exit(1);
  }, 10_000);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
