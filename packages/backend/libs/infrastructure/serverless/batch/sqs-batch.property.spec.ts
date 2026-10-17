import * as fc from 'fast-check';
import { processBatch } from './sqs-batch';
import { sqsRecord } from '../testing';

describe('processBatch invariants', () => {
  it('S55 AS-09: reported IDs are input IDs once in order; a FIFO group runs a prefix and fails from the first failure on', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.array(
          fc.record({
            group: fc.constantFrom('A', 'B', 'C'),
            fails: fc.boolean(),
          }),
          { maxLength: 10 },
        ),
        async (fifo, spec) => {
          const records = spec.map((s, i) =>
            sqsRecord(`m${i}`, { group: s.group, fifo }),
          );
          const ran: string[] = [];
          const res = await processBatch({ Records: records }, async (r) => {
            ran.push(r.messageId);
            if (spec[Number(r.messageId.slice(1))].fails)
              throw new Error('boom');
          });
          const reported = res.batchItemFailures.map((f) => f.itemIdentifier);
          const inputIds = records.map((r) => r.messageId);

          // (a) input IDs, once, in input order
          expect(new Set(reported).size).toBe(reported.length);
          expect(reported).toEqual(
            inputIds.filter((id) => reported.includes(id)),
          );

          // (b) a record that ran and did not fail is not reported
          for (const id of ran)
            if (!spec[Number(id.slice(1))].fails)
              expect(reported).not.toContain(id);

          // (c) FIFO: per group, ran records are a prefix; failed = first failing record + every later one
          if (fifo) {
            for (const group of ['A', 'B', 'C']) {
              const members = records.filter(
                (r) => r.attributes.MessageGroupId === group,
              );
              const ranHere = members.filter((r) => ran.includes(r.messageId));
              expect(ranHere.map((r) => r.messageId)).toEqual(
                members.slice(0, ranHere.length).map((r) => r.messageId),
              );
              const firstFail = members.findIndex(
                (r) => spec[Number(r.messageId.slice(1))].fails,
              );
              const expectedFailed =
                firstFail < 0
                  ? []
                  : members.slice(firstFail).map((r) => r.messageId);
              expect(
                members
                  .map((r) => r.messageId)
                  .filter((id) => reported.includes(id)),
              ).toEqual(expectedFailed);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
