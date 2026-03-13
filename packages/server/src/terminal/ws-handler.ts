import type { WebSocket } from "ws";
import type { WSTerminalClientMessage } from "@qoder-anywhere/shared";
import { TerminalManager } from "./terminal-manager.js";

export function handleTerminalConnection(
  ws: WebSocket,
  terminalId: string,
  manager: TerminalManager,
): void {
  // Subscribe — replays buffered output, then adds ws to live broadcast
  manager.subscribeWS(terminalId, ws);

  ws.on("message", (raw) => {
    let msg: WSTerminalClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "input") {
      manager.write(terminalId, msg.data);
    } else if (msg.type === "resize") {
      manager.resize(terminalId, msg.cols, msg.rows);
    }
  });

  ws.on("close", () => {
    manager.unsubscribeWS(terminalId, ws);
  });
}
