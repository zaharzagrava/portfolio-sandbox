import type { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import {
  CATALOG_IMPORTS_QUEUE,
  ImportQueueAdapter,
} from './import-queue.adapter';

describe('ImportQueueAdapter', () => {
  const adapter = () => {
    const enqueue = jest.fn().mockResolvedValue('m');
    return {
      enqueue,
      queue: new ImportQueueAdapter({ enqueue } as unknown as TaskQueue),
    };
  };
  const id = '0192f3a0-0000-7000-8000-000000000001';

  it('S07 AS-70: the message is {importId} on the standard queue, with no kind, group or dedupe id (L-001)', async () => {
    const { enqueue, queue } = adapter();
    await queue.enqueue(id);
    await queue.enqueue(id, { delaySeconds: 60 });
    expect(CATALOG_IMPORTS_QUEUE).toBe('catalog-imports');
    expect(enqueue.mock.calls).toEqual([
      ['catalog-imports', { importId: id }, undefined],
      ['catalog-imports', { importId: id }, { delaySeconds: 60 }],
    ]);
    for (const [, body, options] of enqueue.mock.calls) {
      expect(Object.keys(body as object)).toEqual(['importId']);
      expect(options ?? {}).not.toHaveProperty('groupId');
      expect(options ?? {}).not.toHaveProperty('dedupeId');
    }
  });

  it('S07 AS-41: a message that is not an import id is refused where it is created, before any queue call', async () => {
    const { enqueue, queue } = adapter();
    await expect(queue.enqueue('not-a-uuid')).rejects.toThrow();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('S07 AS-60: a group id smuggled in through the options is dropped, never forwarded', async () => {
    const { enqueue, queue } = adapter();
    await queue.enqueue(id, { delaySeconds: 5, groupId: 'x' } as never);
    expect(enqueue.mock.calls[0][2]).toEqual({ delaySeconds: 5 });
  });
});
