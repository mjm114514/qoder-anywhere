import * as pty from "node-pty";
import type { IPty } from "node-pty";
import type { WebSocket } from "ws";
import { v4 as uuid } from "uuid";
import { EventEmitter } from "node:events";
import type {
  TerminalInfo,
  WSTerminalServerMessage,
} from "@qoder-anywhere/shared";

const MAX_OUTPUT_BUFFER = 1000;

interface TerminalInstance {
  id: string;
  cwd: string;
  pty: IPty;
  wsClients: Set<WebSocket>;
  outputBuffer: string[];
  createdAt: number;
}

export class TerminalManager extends EventEmitter {
  private terminals = new Map<string, TerminalInstance>();

  create(cwd: string): string {
    const id = uuid();
    const shell = process.env.SHELL || "/bin/bash";

    // Filter out undefined values — node-pty's posix_spawnp fails otherwise
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }

    const p = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd,
      env,
    });

    const instance: TerminalInstance = {
      id,
      cwd,
      pty: p,
      wsClients: new Set(),
      outputBuffer: [],
      createdAt: Date.now(),
    };

    p.onData((data: string) => {
      // Buffer output for replay on reconnect
      instance.outputBuffer.push(data);
      if (instance.outputBuffer.length > MAX_OUTPUT_BUFFER) {
        instance.outputBuffer.shift();
      }

      // Broadcast to all connected WS clients
      const msg: WSTerminalServerMessage = { type: "output", data };
      const payload = JSON.stringify(msg);
      for (const ws of instance.wsClients) {
        if (ws.readyState === ws.OPEN) {
          ws.send(payload);
        }
      }
    });

    p.onExit(({ exitCode }) => {
      // Guard: if kill() already removed this terminal, don't double-emit
      if (!this.terminals.has(id)) return;

      const msg: WSTerminalServerMessage = { type: "exit", exitCode };
      const payload = JSON.stringify(msg);
      for (const ws of instance.wsClients) {
        if (ws.readyState === ws.OPEN) {
          ws.send(payload);
        }
      }
      this.terminals.delete(id);
      this.emit("terminal_closed", { terminalId: id, cwd });
    });

    this.terminals.set(id, instance);
    this.emit("terminal_created", { terminalId: id, cwd });
    console.log(`[terminal] Created terminal ${id} (pid=${p.pid}, cwd=${cwd})`);
    return id;
  }

  write(id: string, data: string): void {
    const instance = this.terminals.get(id);
    if (!instance) return;
    instance.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const instance = this.terminals.get(id);
    if (!instance) return;
    instance.pty.resize(cols, rows);
  }

  kill(id: string): void {
    const instance = this.terminals.get(id);
    if (!instance) return;
    console.log(`[terminal] Killing terminal ${id}`);
    instance.pty.kill();
    this.terminals.delete(id);
    this.emit("terminal_closed", { terminalId: id, cwd: instance.cwd });
  }

  list(cwd?: string): TerminalInfo[] {
    const result: TerminalInfo[] = [];
    for (const inst of this.terminals.values()) {
      if (cwd && inst.cwd !== cwd) continue;
      result.push({
        id: inst.id,
        cwd: inst.cwd,
        pid: inst.pty.pid,
        createdAt: new Date(inst.createdAt).toISOString(),
      });
    }
    return result;
  }

  get(id: string): TerminalInfo | null {
    const inst = this.terminals.get(id);
    if (!inst) return null;
    return {
      id: inst.id,
      cwd: inst.cwd,
      pid: inst.pty.pid,
      createdAt: new Date(inst.createdAt).toISOString(),
    };
  }

  subscribeWS(id: string, ws: WebSocket): void {
    const instance = this.terminals.get(id);
    if (!instance) {
      // Terminal doesn't exist — send exit message
      const msg: WSTerminalServerMessage = { type: "exit", exitCode: -1 };
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(msg));
      }
      return;
    }

    // Replay buffered output so the terminal isn't blank on reconnect
    for (const data of instance.outputBuffer) {
      const msg: WSTerminalServerMessage = { type: "output", data };
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    }

    instance.wsClients.add(ws);
  }

  unsubscribeWS(id: string, ws: WebSocket): void {
    const instance = this.terminals.get(id);
    if (!instance) return;
    instance.wsClients.delete(ws);
  }

  shutdown(): void {
    console.log(
      `[terminal] Shutting down ${this.terminals.size} terminal(s)...`,
    );
    for (const [id, inst] of this.terminals) {
      try {
        inst.pty.kill();
      } catch {
        // ignore — PTY may already be dead
      }
      this.terminals.delete(id);
    }
  }
}
