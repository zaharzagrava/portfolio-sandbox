import { processBatch } from './sqs-batch';
import type { SqsEvent } from './sqs-types';
import { deferred, sqsRecord } from '../testing';

const ids = (res: { batchItemFailures: { itemIdentifier: string }[] }) =>
  res.batchItemFailures.map((f) => f.itemIdentifier);

/** Every Lambda handler reports failures through this - pure → unit spec. */
describe('processBatch', () => {
  it('S55 AS-01: standard queue, only the failed record is reported and each record ran once', async () => {
    const event: SqsEvent = {
      Records: ['a', 'b', 'c'].map((id) => sqsRecord(id)),
    };
    const calls: string[] = [];
    const res = await processBatch(event, async (r) => {
      calls.push(r.messageId);
      if (r.body === 'b') throw new Error('boom');
    });
    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: 'b' }] });
    expect(calls.sort()).toEqual(['a', 'b', 'c']);
  });

  it.each([
    ['every record succeeds', ['a', 'b', 'c'], [], []],
    ['every record fails', ['a', 'b', 'c'], ['a', 'b', 'c'], ['a', 'b', 'c']],
    ['no records', [], [], []],
  ])(
    'S55 AS-02: %s',
    async (_name, input: string[], failing: string[], expected: string[]) => {
      let calls = 0;
      const res = await processBatch(
        { Records: input.map((id) => sqsRecord(id)) },
        async (r) => {
          calls++;
          if (failing.includes(r.messageId)) throw new Error('boom');
        },
      );
      expect(ids(res)).toEqual(expected);
      expect(calls).toBe(input.length);
    },
  );

  it('S55 AS-03: FIFO, a failure fails the rest of its group without running it', async () => {
    const event: SqsEvent = {
      Records: [
        sqsRecord('a1', { group: 'A', fifo: true }),
        sqsRecord('a2', { group: 'A', fifo: true }),
        sqsRecord('b1', { group: 'B', fifo: true }),
        sqsRecord('a3', { group: 'A', fifo: true }),
      ],
    };
    const ran: string[] = [];
    const res = await processBatch(event, async (r) => {
      ran.push(r.body);
      if (r.body === 'a2') throw new Error('boom');
    });
    expect(ran.sort()).toEqual(['a1', 'a2', 'b1']);
    expect(ids(res)).toEqual(['a2', 'a3']);
  });

  it('S55 AS-04: FIFO groups run in parallel, a group runs one record at a time', async () => {
    const event: SqsEvent = {
      Records: [
        sqsRecord('a1', { group: 'A', fifo: true }),
        sqsRecord('a2', { group: 'A', fifo: true }),
        sqsRecord('b1', { group: 'B', fifo: true }),
      ],
    };
    const gate = deferred();
    const started: string[] = [];
    let inA = 0;
    let maxInA = 0;
    const done = processBatch(event, async (r) => {
      started.push(r.messageId);
      if (r.messageId.startsWith('a')) {
        maxInA = Math.max(maxInA, ++inA);
        if (r.messageId === 'a1') await gate.promise;
        inA--;
      }
    });
    await new Promise((r) => setImmediate(r));
    expect(started).toContain('b1');
    expect(started).not.toContain('a2');
    gate.resolve();
    await done;
    expect(started).toContain('a2');
    expect(maxInA).toBe(1);
  });

  it('S55 AS-05: standard queue, never more than the concurrency limit in flight', async () => {
    const event: SqsEvent = {
      Records: ['1', '2', '3', '4', '5'].map((id) => sqsRecord(id)),
    };
    let inFlight = 0;
    let max = 0;
    let ran = 0;
    await processBatch(
      event,
      async () => {
        max = Math.max(max, ++inFlight);
        await new Promise((r) => setImmediate(r));
        inFlight--;
        ran++;
      },
      { concurrency: 2 },
    );
    expect(max).toBe(2);
    expect(ran).toBe(5);
  });

  it('S55 AS-07: any thrown or rejected value fails only its record', async () => {
    const thrown: [string, () => unknown][] = [
      ['error', () => new Error('x')],
      ['string', () => 'text'],
      ['undefined', () => undefined],
      ['null', () => null],
    ];
    const res = await processBatch(
      { Records: thrown.map(([id]) => sqsRecord(id)) },
      async (r) => {
        const value = thrown.find(([id]) => id === r.messageId)![1]();
        if (r.messageId === 'null') return Promise.reject(value);
        throw value;
      },
    );
    expect(ids(res)).toEqual(['error', 'string', 'undefined', 'null']);
  });

  it.each([
    ['standard', false],
    ['FIFO', true],
  ])(
    'S55 AS-08: %s, records not started before the deadline margin are reported failed in order',
    async (_name, fifo) => {
      const records = ['r1', 'r2', 'r3', 'r4'].map((id) =>
        sqsRecord(id, { group: 'G', fifo }),
      );
      let remaining = 60_000;
      const ran: string[] = [];
      const res = await processBatch(
        { Records: records },
        async (r) => {
          ran.push(r.messageId);
          remaining = 4_000; // under the 5 s margin after the first record
        },
        {
          concurrency: 1,
          deadlineMarginMs: 5_000,
          remainingTimeMs: () => remaining,
        },
      );
      expect(ran).toEqual(['r1']);
      expect(ids(res)).toEqual(['r2', 'r3', 'r4']);
    },
  );
});
