import { v7 as uuidv7 } from 'uuid';
import { waitFor } from '@app/test/utils/async-helpers';
import { readTopic } from '@app/test/utils/kafka-test';
import { ConsumerKit } from '@app/infrastructure/events/testing/consumer-kit';

const kit = new ConsumerKit();

describe('Contract evolution: tolerant readers', () => {
  beforeAll(() => kit.start());
  afterAll(() => kit.stopAll());

  it('S53 AS-107: an extra field in the same version is ignored; a missing required field is dead-lettered with the path, never a value', async () => {
    const s = await kit.scenario();
    const Natural = s.make('natural');
    const app = await s.boot([Natural]);
    const consumer = app.get(Natural);
    const [extra, missing] = [uuidv7(), uuidv7()];

    const withExtra = s.ItemChanged.create(extra, 1, { name: 'has-extra' });
    const noName = {
      ...s.ItemChanged.create(missing, 1, { name: 'x' }),
      payload: { note: 'SECRET-NOTE' },
    };
    await s.publish([
      {
        ...withExtra,
        payload: {
          ...withExtra.payload,
          addedLater: 'optional field of a newer producer',
        },
      },
      noName,
    ] as never[]);

    await waitFor(
      async () =>
        (await kit.naturalRows(consumer.name)) === 1 &&
        (await readTopic(`${consumer.name}.dlq`)).length === 1,
      { description: 'one applied, one dead-lettered' },
    );
    expect(
      consumer.probe.calls.flatMap((c) => c.events).map((e) => e.aggregateId),
    ).toEqual([extra]);
    const [letter] = await readTopic(`${consumer.name}.dlq`);
    expect(letter.headers['x-dlq-reason-code']).toBe('INVALID_PAYLOAD');
    expect(letter.headers['x-dlq-reason']).toContain('name');
    expect(letter.headers['x-dlq-reason']).not.toContain('SECRET-NOTE');
  });
});
