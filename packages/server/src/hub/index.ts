import { createHubApp } from "./hub-app.js";
import { HubNodeManager } from "./hub-node-manager.js";
import { attachHubWebSocket } from "./hub-ws-handler.js";
import { config } from "../config.js";
import { loadAuthConfig, type AuthConfig } from "../auth/config.js";

export interface HubServerOptions {
  port?: number;
  authConfig?: AuthConfig;
}

export async function startHubServer(options: HubServerOptions = {}) {
  const port = options.port ?? config.port;
  const authConfig = options.authConfig ?? loadAuthConfig();

  const nodeManager = new HubNodeManager();
  const app = createHubApp(nodeManager, authConfig);

  const server = app.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log();
    console.log(`[lgtm-anywhere hub] Hub server listening on ${url}`);
    console.log(
      `[lgtm-anywhere hub] Nodes connect via ws://localhost:${port}/ws/hub/connect`,
    );
    if (authConfig.enabled) {
      console.log();
      console.log("┌────────────────────────────────────────────────────────┐");
      console.log(`│  Auth token: ${authConfig.authToken.padEnd(42)}│`);
      console.log("└────────────────────────────────────────────────────────┘");
      console.log();
    } else {
      console.log(
        "[lgtm-anywhere hub] ⚠ Auth disabled — server is open (localhost only recommended)",
      );
    }
  });

  attachHubWebSocket(server, nodeManager, authConfig);

  // Graceful shutdown
  let shuttingDown = false;
  function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`\n[${signal}] Shutting down hub...`);
    nodeManager.shutdown();
    server.close();
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  return server;
}
