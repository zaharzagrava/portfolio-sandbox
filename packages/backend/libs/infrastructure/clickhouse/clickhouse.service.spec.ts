import type { ApiConfigService } from '@app/common/config';
import { ClickHouseService } from './clickhouse.service';

type FakeClient = {
  insert: jest.Mock;
  query: jest.Mock;
};

function serviceWith(client: FakeClient): ClickHouseService {
  const service = new ClickHouseService({} as ApiConfigService);
  (service as unknown as { client: FakeClient }).client = client;
  return service;
}

describe('ClickHouseService durable insert', () => {
  it('S18 T004: waits for the server to store the rows and sends them as JSONEachRow', async () => {
    const client = {
      insert: jest.fn().mockResolvedValue({}),
      query: jest.fn(),
    };
    await serviceWith(client).insert('usage_events', [{ event_id: 'e1' }]);
    expect(client.insert).toHaveBeenCalledTimes(1);
    expect(client.insert.mock.calls[0][0]).toMatchObject({
      table: 'usage_events',
      values: [{ event_id: 'e1' }],
      format: 'JSONEachRow',
      clickhouse_settings: { async_insert: 1, wait_for_async_insert: 1 },
    });
  });

  it('S18 T004: rejects when the store rejects (the caller is redelivered, nothing is dropped)', async () => {
    const client = {
      insert: jest.fn().mockRejectedValue(new Error('boom')),
      query: jest.fn(),
    };
    await expect(
      serviceWith(client).insert('usage_events', [{ event_id: 'e1' }]),
    ).rejects.toThrow('boom');
  });

  it('S18 T004: rejects after the explicit timeout when the store never answers', async () => {
    const client = {
      insert: jest.fn(
        ({ abort_signal }: { abort_signal: AbortSignal }) =>
          new Promise((_, reject) =>
            abort_signal.addEventListener('abort', () =>
              reject(new Error('aborted')),
            ),
          ),
      ),
      query: jest.fn(),
    };
    await expect(
      serviceWith(client).insert('usage_events', [{ event_id: 'e1' }], {
        timeoutMs: 20,
      }),
    ).rejects.toThrow('timed out after 20 ms');
  });

  it('S18 T004: an empty batch does not call the store', async () => {
    const client = { insert: jest.fn(), query: jest.fn() };
    await serviceWith(client).insert('usage_events', []);
    expect(client.insert).not.toHaveBeenCalled();
  });
});
