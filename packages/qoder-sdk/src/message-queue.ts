/**
 * MessageQueue — an AsyncIterable producer/consumer bridge.
 *
 * Used for streaming-input mode: the caller pushes QoderUserMessages
 * into the queue, and the transport consumes them as an async iterable
 * to write to qodercli's stdin.
 */

export class MessageQueue<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private resolve: ((value: IteratorResult<T>) => void) | null = null;
  private done = false;

  /**
   * Push a message into the queue.
   * If a consumer is waiting, it is resolved immediately.
   */
  push(item: T): void {
    if (this.done) {
      throw new Error("MessageQueue is closed");
    }
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r({ value: item, done: false });
    } else {
      this.queue.push(item);
    }
  }

  /**
   * Close the queue. Any pending or future consumers will receive `done: true`.
   */
  close(): void {
    this.done = true;
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r({ value: undefined as unknown as T, done: true });
    }
  }

  /**
   * AsyncIterator implementation — yields queued items,
   * or waits for the next push().
   */
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.queue.length > 0) {
          return Promise.resolve({
            value: this.queue.shift()!,
            done: false,
          });
        }
        if (this.done) {
          return Promise.resolve({
            value: undefined as unknown as T,
            done: true,
          });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.resolve = resolve;
        });
      },
      return: (): Promise<IteratorResult<T>> => {
        this.done = true;
        return Promise.resolve({
          value: undefined as unknown as T,
          done: true,
        });
      },
    };
  }
}
