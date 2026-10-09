import { randomUUID } from 'node:crypto';
import { validateEnqueueOptions } from './enqueue-options';
import {
  BatchResult,
  BodySchema,
  ConsumeOptions,
  EnqueueOptions,
  TaskMessage,
  TaskQueue,
} from './task-queue.port';

/** Test double: records enqueued messages; `drain()` delivers them to registered handlers synchronously. */
export class InMemoryTaskQueue extends TaskQueue {
  readonly sent: { queue: string; body: unknown; options?: EnqueueOptions }[] =
    [];
  private readonly handlers = new Map<
    string,
    (msg: TaskMessage<unknown>) => Promise<void>
  >();

  enqueue<T>(queue: string, body: T, options?: EnqueueOptions) {
    try {
      validateEnqueueOptions(queue, options);
    } catch (error) {
      return Promise.reject(error as Error);
    }
    this.sent.push({ queue, body, options });
    return Promise.resolve(randomUUID());
  }

  async enqueueBatch<T>(
    queue: string,
    bodies: { body: T; options?: EnqueueOptions }[],
  ): Promise<BatchResult> {
    for (const { options } of bodies) validateEnqueueOptions(queue, options);
    for (const { body, options } of bodies)
      await this.enqueue(queue, body, options);
    return { sent: bodies.length, failed: [] };
  }

  /** Bodies a consumer's `bodySchema` refused, as the real adapter would send them to the dead-letter queue. */
  readonly deadLettered: { queue: string; body: unknown; reason: string }[] =
    [];
  private readonly schemas = new Map<string, BodySchema>();

  consume<T>(
    queue: string,
    handler: (msg: TaskMessage<T>) => Promise<void>,
    options?: ConsumeOptions,
  ) {
    this.handlers.set(queue, handler);
    if (options?.bodySchema) this.schemas.set(queue, options.bodySchema);
    return () => {
      this.handlers.delete(queue);
      this.schemas.delete(queue);
      return Promise.resolve();
    };
  }

  async drain(queue: string): Promise<void> {
    const handler = this.handlers.get(queue);
    if (!handler) return;
    const schema = this.schemas.get(queue);
    const pending = this.sent.filter((m) => m.queue === queue);
    this.sent.splice(
      0,
      this.sent.length,
      ...this.sent.filter((m) => m.queue !== queue),
    );
    for (const m of pending) {
      if (schema && !schema.safeParse(m.body).success) {
        this.deadLettered.push({
          queue,
          body: m.body,
          reason: 'SCHEMA_INVALID',
        });
        continue;
      }
      await handler({
        id: randomUUID(),
        body: m.body,
        receiveCount: 1,
        attributes: {},
      });
    }
  }
}
