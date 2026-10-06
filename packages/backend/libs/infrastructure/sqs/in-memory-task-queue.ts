import { randomUUID } from 'node:crypto';
import { ConsumeOptions, EnqueueOptions, TaskMessage, TaskQueue } from './task-queue.port';

/** Test double: records enqueued messages; `drain()` delivers them to registered handlers synchronously. */
export class InMemoryTaskQueue extends TaskQueue {
  readonly sent: { queue: string; body: unknown; options?: EnqueueOptions }[] = [];
  private readonly handlers = new Map<string, (msg: TaskMessage<unknown>) => Promise<void>>();

  async enqueue<T>(queue: string, body: T, options?: EnqueueOptions) {
    this.sent.push({ queue, body, options });
    return randomUUID();
  }

  async enqueueBatch<T>(queue: string, bodies: { body: T; options?: EnqueueOptions }[]) {
    for (const { body, options } of bodies) await this.enqueue(queue, body, options);
  }

  consume<T>(queue: string, handler: (msg: TaskMessage<T>) => Promise<void>, _options?: ConsumeOptions) {
    this.handlers.set(queue, handler as (msg: TaskMessage<unknown>) => Promise<void>);
    return async () => void this.handlers.delete(queue);
  }

  async drain(queue: string): Promise<void> {
    const handler = this.handlers.get(queue);
    if (!handler) return;
    const pending = this.sent.filter((m) => m.queue === queue);
    this.sent.splice(0, this.sent.length, ...this.sent.filter((m) => m.queue !== queue));
    for (const m of pending) {
      await handler({ id: randomUUID(), body: m.body, receiveCount: 1, attributes: {} });
    }
  }
}
