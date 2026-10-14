import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { RequestRecord, RequestRecordPublisher } from '../domain/ports';
import { RequestRecordSink } from './request-record.sink';

const record = (n: number): RequestRecord => ({
  requestId: `req_${n}`,
  shopId: 's',
  keyId: 'k',
  livemode: true,
  version: '2026-10-01',
  method: 'GET',
  route: '/v1/products',
  status: 200,
  durationMs: 1,
  deprecated: false,
  idempotentReplay: false,
  cost: 1,
  occurredAt: new Date('2026-10-06T12:00:00Z'),
});

class FakePublisher extends RequestRecordPublisher {
  down = false;
  readonly delivered: string[] = [];
  attempts = 0;
  async publish(records: RequestRecord[]): Promise<void> {
    this.attempts += 1;
    if (this.down) throw new Error('bus down');
    this.delivered.push(...records.map((r) => r.requestId));
  }
}

const dropped = () =>
  MetricsRegistry.value('public_api_request_log_dropped_total') ?? 0;

describe('S42 request record sink (FR-054, AS-61)', () => {
  const options = { capacity: 5, batch: 2, backoffMs: [1, 2] };

  it('hands records over without waiting for the bus', async () => {
    const bus = new FakePublisher();
    const sink = new RequestRecordSink(bus, options);
    const before = process.hrtime.bigint();
    for (let i = 0; i < 5; i += 1) sink.record(record(i));
    expect(Number(process.hrtime.bigint() - before) / 1e6).toBeLessThan(20);
    await sink.flush();
    expect(bus.delivered).toEqual([
      'req_0',
      'req_1',
      'req_2',
      'req_3',
      'req_4',
    ]);
  });

  it('keeps records while the bus is down and delivers each once, in order, after recovery', async () => {
    const bus = new FakePublisher();
    bus.down = true;
    const sink = new RequestRecordSink(bus, options);
    for (let i = 0; i < 4; i += 1) sink.record(record(i));
    await new Promise((r) => setTimeout(r, 30));
    expect(bus.delivered).toEqual([]);
    expect(bus.attempts).toBeGreaterThan(1);
    bus.down = false;
    await sink.flush();
    expect(bus.delivered).toEqual(['req_0', 'req_1', 'req_2', 'req_3']);
  });

  it('on overflow drops the oldest and counts each drop', async () => {
    const bus = new FakePublisher();
    bus.down = true;
    const sink = new RequestRecordSink(bus, options);
    const before = dropped();
    for (let i = 0; i < 8; i += 1) sink.record(record(i));
    expect(dropped() - before).toBe(3);
    bus.down = false;
    await sink.flush();
    expect(bus.delivered).toEqual([
      'req_3',
      'req_4',
      'req_5',
      'req_6',
      'req_7',
    ]);
  });

  it('shutdown flushes what is pending', async () => {
    const bus = new FakePublisher();
    const sink = new RequestRecordSink(bus, options);
    sink.record(record(1));
    await sink.onModuleDestroy();
    expect(bus.delivered).toEqual(['req_1']);
  });
});
