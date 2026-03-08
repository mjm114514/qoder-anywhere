import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

export interface ServerHandle {
  port: number;
  baseUrl: string;
  wsUrl: string;
  stop: () => Promise<void>;
}

/** Bind a temporary TCP server to port 0 to discover a free port. */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("Failed to get port")));
      }
    });
    srv.on("error", reject);
  });
}

/**
 * Spawn the server process on a free port and wait until it prints
 * "Server listening" to stdout.
 */
export async function startServer(): Promise<ServerHandle> {
  const port = await findFreePort();

  const child: ChildProcess = spawn(
    "npx",
    ["tsx", "packages/server/src/index.ts"],
    {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Server failed to start within 30s"));
    }, 30_000);

    child.stdout!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      if (text.includes("Server listening")) {
        clearTimeout(timeout);
        resolve();
      }
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      // Log stderr for debugging but don't fail on it
      process.stderr.write(`[server stderr] ${chunk.toString()}`);
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    child.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited unexpectedly with code ${code}`));
    });
  });

  const stop = () =>
    new Promise<void>((resolve) => {
      if (!child.pid || child.killed) {
        resolve();
        return;
      }

      const forceKill = setTimeout(() => {
        child.kill("SIGKILL");
      }, 5_000);

      child.on("exit", () => {
        clearTimeout(forceKill);
        resolve();
      });

      child.kill("SIGTERM");
    });

  return {
    port,
    baseUrl: `http://localhost:${port}`,
    wsUrl: `ws://localhost:${port}`,
    stop,
  };
}
