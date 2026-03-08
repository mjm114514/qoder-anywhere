import WebSocket from "ws";

export interface WSMessage {
  event: string;
  data: unknown;
}

export class WSClient {
  private ws: WebSocket;
  private messages: WSMessage[] = [];
  private waiters: Array<{
    predicate: (msg: WSMessage) => boolean;
    resolve: (msg: WSMessage) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (raw) => {
      const msg: WSMessage = JSON.parse(raw.toString());
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

  /** Wait for a message whose `event` field matches `name`. */
  waitForEvent(name: string, timeoutMs = 90_000): Promise<WSMessage> {
    // Check already-received messages
    const existing = this.messages.find((m) => m.event === name);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(
          new Error(
            `Timed out waiting for event "${name}" after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      this.waiters.push({
        predicate: (msg) => msg.event === name,
        resolve,
        reject,
        timer,
      });
    });
  }

  /** Shorthand for waitForEvent("result"). */
  waitForResult(timeoutMs = 90_000): Promise<WSMessage> {
    return this.waitForEvent("result", timeoutMs);
  }

  /** Send a user message through the WebSocket. */
  sendMessage(text: string): void {
    this.ws.send(JSON.stringify({ type: "message", message: text }));
  }

  /** Get all accumulated messages. */
  getMessages(): WSMessage[] {
    return [...this.messages];
  }

  /** Close the WebSocket connection. */
  close(): void {
    this.ws.close();
  }
}
