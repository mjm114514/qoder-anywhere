import type { QoderUserMessage, ContentBlock } from "qoder-sdk";
import type { UserImageAttachment } from "@lgtm-anywhere/shared";

/**
 * MessageQueue bridges user messages to the SDK's streaming input mode.
 * Implements AsyncIterable<QoderUserMessage> so it can be passed as `prompt` to `query()`.
 * As long as `close()` hasn't been called, the query's async generator stays alive.
 */
export class MessageQueue {
  private messages: QoderUserMessage[] = [];
  private waiting: ((msg: QoderUserMessage) => void) | null = null;
  private closed = false;

  push(content: string, images?: UserImageAttachment[]): void {
    // When images are present, build an array of content blocks (text + image)
    // instead of a plain string so the SDK sees proper image content blocks.
    let messageContent: string | ContentBlock[] = content;
    if (images && images.length > 0) {
      const blocks = [
        { type: "text" as const, text: content },
        ...images.map((img) => ({
          type: "image" as const,
          source: {
            type: "base64",
            media_type: img.media_type,
            data: img.data,
          },
        })),
      ];
      messageContent = blocks as unknown as ContentBlock[];
    }

    const msg: QoderUserMessage = {
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

  async *[Symbol.asyncIterator](): AsyncGenerator<QoderUserMessage> {
    while (!this.closed) {
      if (this.messages.length > 0) {
        yield this.messages.shift()!;
      } else {
        const msg = await new Promise<QoderUserMessage>((resolve) => {
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
