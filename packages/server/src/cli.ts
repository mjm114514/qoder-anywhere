#!/usr/bin/env node
// CLI entry point for lgtm-anywhere

import { parseArgs } from "node:util";
import os from "node:os";
import { startServer } from "./index.js";
import { loadAuthConfig, refreshToken } from "./auth/config.js";

function printHelp() {
  console.log(`Usage: lgtm-anywhere [options]

Options:
  -p, --port <port>              Port to listen on (default: 3001)
      --no-auth                  Disable authentication
      --hub                      Start in hub mode
      --connect <hub-url>        Connect to a hub server
      --access-code <code>       Access code for hub connection
      --refresh-token            Refresh the auth token and exit
  -h, --help                     Show this help message`);
}

const cliOptions = {
  port: { type: "string", short: "p", default: "3001" },
  "no-auth": { type: "boolean", default: false },
  hub: { type: "boolean", default: false },
  connect: { type: "string" },
  "access-code": { type: "string" },
  "refresh-token": { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
} as const;

let values: ReturnType<
  typeof parseArgs<{ options: typeof cliOptions }>
>["values"];
try {
  ({ values } = parseArgs({ options: cliOptions }));
} catch {
  printHelp();
  process.exit(1);
}

if (values.help) {
  printHelp();
  process.exit(0);
}

// Handle --refresh-token: generate new token, print it, and exit
if (values["refresh-token"]) {
  const token = refreshToken();
  console.log("[lgtm-anywhere] Auth token refreshed.");
  console.log();
  console.log(`  ${token}`);
  console.log();
  process.exit(0);
}

const port = parseInt(values.port!, 10);
const authConfig = loadAuthConfig({
  enabled: !values["no-auth"],
});

if (values.hub) {
  // Hub mode — start the hub server
  const { startHubServer } = await import("./hub/index.js");
  startHubServer({ port, authConfig });
} else if (values.connect) {
  // Connect mode — start local server + connect to hub
  const accessCode = values["access-code"];
  if (!accessCode) {
    console.error(
      "[lgtm-anywhere] --access-code is required when using --connect",
    );
    console.error(
      "  Usage: lgtm-anywhere --connect <hub-url> --access-code <code>",
    );
    console.error(
      "  The access code is shown in the hub's terminal when it starts.",
    );
    process.exit(1);
  }

  const { NodeConnector } = await import("./hub/node-connector.js");

  const server = await startServer({ port, authConfig });
  const nodeName = os.hostname();

  const connector = new NodeConnector({
    hubUrl: values.connect,
    nodeName,
    localPort: port,
    accessCode,
  });

  connector.connect();

  // Replace shutdown handlers to also disconnect from hub
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");

  let shuttingDown = false;
  function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[${signal}] Shutting down...`);
    connector.shutdown();
    server.close();
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  console.log(`[lgtm-anywhere] Connecting to hub at ${values.connect}`);
  console.log(`[lgtm-anywhere] Node name: ${nodeName}`);
} else {
  // Normal mode
  startServer({ port, authConfig });
}
