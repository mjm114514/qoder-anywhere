/**
 * query() — the main entry point for interacting with qodercli.
 *
 * Spawns a qodercli subprocess and yields QoderMessage events from stdout
 * as an async generator.
 *
 * Always uses streaming mode (matching @anthropic-ai/claude-agent-sdk):
 *   `--input-format stream-json --output-format stream-json`
 *
 * Supports two prompt forms (both go through stdin):
 *
 * 1. **String prompt**: Convenience form — the SDK wraps it into a single
 *    QoderUserMessage and sends it via stdin, then closes stdin.
 *
 * 2. **AsyncIterable<QoderUserMessage>**: Multi-turn streaming — user
 *    messages are piped to stdin as NDJSON. stdin closes when the iterable
 *    completes.
 */

import type {
  QoderMessage,
  QoderUserMessage,
  QueryOptions,
  Query,
  PermissionMode,
} from "./types.js";
import { ProcessTransport } from "./transport.js";

export type QueryParams = {
  /** A string prompt or an AsyncIterable of user messages for streaming input. */
  prompt: string | AsyncIterable<QoderUserMessage>;
  /** Options controlling the qodercli subprocess. */
  options?: QueryOptions;
};

/**
 * Create a Query (AsyncGenerator<QoderMessage>) that drives a qodercli session.
 *
 * @example
 * ```ts
 * // One-shot query (string prompt — auto-wrapped and sent via stdin)
 * const q = query({
 *   prompt: "Explain async/await",
 *   options: { cwd: "/my/project", maxTurns: 3 },
 * });
 * for await (const msg of q) {
 *   console.log(msg);
 * }
 * ```
 *
 * @example
 * ```ts
 * // Streaming input with MessageQueue
 * import { MessageQueue } from "qoder-sdk";
 *
 * const mq = new MessageQueue<QoderUserMessage>();
 * const q = query({ prompt: mq, options: { cwd: "/my/project" } });
 *
 * // Push messages into the queue
 * mq.push({
 *   type: "user",
 *   message: { role: "user", content: [{ type: "text", text: "Hello" }] },
 *   session_id: "",
 * });
 *
 * // Consume responses
 * for await (const msg of q) {
 *   console.log(msg);
 *   if (msg.type === "system" && msg.subtype === "init") {
 *     // Now we have the session_id, can push more messages
 *     mq.push({
 *       type: "user",
 *       message: { role: "user", content: [{ type: "text", text: "What files are here?" }] },
 *       session_id: msg.session_id,
 *     });
 *   }
 * }
 * ```
 */
export function query(params: QueryParams): Query {
  const { prompt, options = {} } = params;

  // Always create transport in streaming mode
  const transport = new ProcessTransport(options);

  // Set up abort handling
  if (options.abortController) {
    const signal = options.abortController.signal;
    if (signal.aborted) {
      transport.kill();
    } else {
      signal.addEventListener(
        "abort",
        () => {
          transport.kill();
        },
        { once: true }
      );
    }
  }

  const isOneShot = typeof prompt === "string";

  // The core async generator that yields messages
  async function* generate(): AsyncGenerator<QoderMessage, void, undefined> {
    transport.start();

    // Build the input source:
    // - String prompt → wrap into a single QoderUserMessage, send, then close stdin
    // - AsyncIterable → pipe messages to stdin, close when iterable completes
    const inputPipe = (async () => {
      try {
        if (typeof prompt === "string") {
          // String prompt: wrap into QoderUserMessage and send via stdin
          const userMessage: QoderUserMessage = {
            type: "user",
            message: {
              role: "user",
              content: [{ type: "text", text: prompt }],
            },
            session_id: "",
            parent_tool_use_id: null,
          };
          transport.write(userMessage);
        } else {
          // AsyncIterable: pipe all messages to stdin as they arrive.
          // The iterable stays open for multi-turn — stdin closes only
          // when the iterable completes (e.g. MessageQueue.close()).
          for await (const userMsg of prompt) {
            transport.write(userMsg);
          }
        }
      } finally {
        transport.closeStdin();
      }
    })();

    // Read output messages from qodercli stdout.
    //
    // Completion semantics:
    //   - One-shot (string prompt): `result` message → break immediately.
    //   - Multi-turn (AsyncIterable): `result` only means the current turn
    //     is done. The process stays alive waiting for the next user message.
    //     The generator ends when the process exits (readline closes).
    //
    // maxTurns tracking:
    //   --max-turns only works with --print mode in qodercli, not streaming.
    //   We track turns internally: each `result` message completes a turn.
    let turnCount = 0;
    const maxTurns = options.maxTurns;

    try {
      for await (const message of transport.readMessages()) {
        yield message;
        if (message.type === "result") {
          turnCount++;
          if (isOneShot) break;
          if (maxTurns && turnCount >= maxTurns) {
            transport.kill();
            break;
          }
        }
      }
    } finally {
      // Ensure process and input pipe are cleaned up
      transport.kill();
      await inputPipe.catch(() => {
        // Swallow errors from the input pipe if the process was killed
      });
    }
  }

  // Create the base generator
  const gen = generate();

  // Wrap it as a Query with .close() and .interrupt()
  const queryObj = gen as Query;

  queryObj.close = () => {
    transport.kill();
  };

  queryObj.interrupt = async () => {
    transport.interrupt();
  };

  queryObj.setModel = async (model?: string) => {
    await transport.sendControlRequest("set_model", { model: model ?? null });
  };

  queryObj.setPermissionMode = async (mode: PermissionMode) => {
    await transport.sendControlRequest("set_permission_mode", {
      permission_mode: mode,
    });
  };

  return queryObj;
}
