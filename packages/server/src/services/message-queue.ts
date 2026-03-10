import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { UserImageAttachment } from "@lgtm-anywhere/shared";

/**
 * MessageQueue bridges user messages to the SDK's streaming input mode.
 * Implements AsyncIterable<SDKUserMessage> so it can be passed as `prompt` to `query()`.
 * As long as `close()` hasn't been called, the query's async generator stays alive.
 */
export class MessageQueue {
  private messages: SDKUserMessage[] = [];
  private waiting: ((msg: SDKUserMessage) => void) | null = null;
  private closed = false;

  push(content: string, images?: UserImageAttachment[]): void {
    // When images are present, build an array of content blocks (text + image)
    // instead of a plain string so the SDK sees proper image content blocks.
    let messageContent: string | Array<Record<string, unknown>> = content;
    if (images && images.length > 0) {
      const blocks: Array<Record<string, unknown>> = [
        { type: "text", text: content },
        ...images.map((img) => ({
          type: "image",
          source: {
            type: "base64",
            media_type: img.media_type,
            data: img.data,
          },
        })),
      ];
      messageContent = blocks;
    }

    const msg: SDKUserMessage = {
      type: "user" as const,
      session_id: "",
      message: { role: "user" as const, content: messageContent },
      parent_tool_use_id: null,
    };
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve(msg);
    } else {
      this.messages.push(msg);
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      if (this.messages.length > 0) {
        yield this.messages.shift()!;
      } else {
        const msg = await new Promise<SDKUserMessage>((resolve) => {
          this.waiting = resolve;
        });
        if (this.closed) break;
        yield msg;
      }
    }
  }

  close(): void {
    this.closed = true;
    // Unblock any pending wait
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      // Push a dummy message to unblock, but closed flag will cause break
      resolve({
        type: "user",
        session_id: "",
        message: { role: "user", content: "" },
        parent_tool_use_id: null,
      });
    }
  }
}
