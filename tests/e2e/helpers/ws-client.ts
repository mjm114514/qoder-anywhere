import WebSocket from "ws";
import type { WSServerMessage } from "@qoder-anywhere/shared";

export class WSClient {
  private ws: WebSocket;
  private messages: WSServerMessage[] = [];
  private waiters: Array<{
    predicate: (msg: WSServerMessage) => boolean;
    resolve: (msg: WSServerMessage) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (raw) => {
      const msg: WSServerMessage = JSON.parse(raw.toString());
      this.messages.push(msg);
      // Check if any waiters match
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        const w = this.waiters[i];
        if (w.predicate(msg)) {
          clearTimeout(w.timer);
          this.waiters.splice(i, 1);
          w.resolve(msg);
        }
      }
    });
  }

  /** Connect to a WebSocket URL and resolve once the connection is open. */
  static connect(url: string): Promise<WSClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.on("open", () => resolve(new WSClient(ws)));
      ws.on("error", (err) => reject(err));
    });
  }

  /**
   * Wait for an SDK message with the given type
   * (e.g., "result", "assistant", "stream_event").
   */
  waitForSdkMessage(
    type: string,
    timeoutMs = 90_000,
  ): Promise<WSServerMessage> {
    const predicate = (msg: WSServerMessage) =>
      msg.category === "sdk" && msg.message.type === type;

    // Check already-received messages
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(
          new Error(
            `Timed out waiting for SDK message "${type}" after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }

  /**
   * Wait for a control message with the given type
   * (e.g., "error", "history_batch_end", "session_message").
   */
  waitForControlMessage(
    type: string,
    timeoutMs = 90_000,
  ): Promise<WSServerMessage> {
    const predicate = (msg: WSServerMessage) =>
      msg.category === "control" && msg.message.type === type;

    // Check already-received messages
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(
          new Error(
            `Timed out waiting for control message "${type}" after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }

  /** Shorthand for waitForSdkMessage("result"). */
  waitForResult(timeoutMs = 90_000): Promise<WSServerMessage> {
    return this.waitForSdkMessage("result", timeoutMs);
  }

  /** Send a user message through the WebSocket. */
  sendMessage(text: string): void {
    this.ws.send(JSON.stringify({ type: "message", message: text }));
  }

  /** Get all accumulated messages. */
  getMessages(): WSServerMessage[] {
    return [...this.messages];
  }

  /** Close the WebSocket connection. */
  close(): void {
    this.ws.close();
  }
}
