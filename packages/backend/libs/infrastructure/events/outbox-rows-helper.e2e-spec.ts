import { INestApplication } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { outboxRowsFor } from '@app/common/testing';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { TransactionRunner } from '@app/infrastructure/context';
import { FixturesModule } from './testing/fixtures.module';
import { FixtureService } from './testing/fixture.service';

const TENANT = '00000000-0000-7000-8000-0000000000bb';

describe('outboxRowsFor test helper', () => {
  let app: INestApplication;
  let fixtures: FixtureService;

  beforeAll(async () => {
    const moduleRef = await generateTestingModule([FixturesModule]);
    app = moduleRef.createNestApplication();
    await app.init();
    fixtures = app.get(FixtureService);
  });
  afterAll(() => app.close());

  it('S53 G-56: returns the rows of one aggregate in append order, with the contract fields and the envelope', async () => {
    const id = await fixtures.seed(TENANT, 'helper', 0);
    await fixtures.rename(id, 0, 'first');
    await fixtures.rename(id, 1, 'second');

    const rows = await outboxRowsFor(app, id);

    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => r.type?.startsWith('fixtures.'))).toBe(true);
    for (const row of rows)
      expect(row).toMatchObject({
        kind: 'event',
        status: 'pending',
        topic: 'fixtures.events',
        aggregateId: id,
        aggregateType: 'fixtures',
      });
    expect(
      rows.map(
        (r) => (r.payload as { aggregateVersion: number }).aggregateVersion,
      ),
    ).toEqual(
      [
        ...rows.map(
          (r) => (r.payload as { aggregateVersion: number }).aggregateVersion,
        ),
      ].sort((a, b) => a - b),
    );
  });

  it('S53 G-56: shows task rows too, and nothing for an aggregate without rows', async () => {
    const id = uuidv7();
    await app.get(TransactionRunner).run(() =>
      app.get(OutboxService).appendTask({
        queue: 'helper-queue',
        type: 'helper.task',
        aggregateId: id,
        body: { n: 1 },
      }),
    );

    const rows = await outboxRowsFor(app, id);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'task',
      status: 'pending',
      topic: 'helper-queue',
      type: 'helper.task',
      aggregateType: null,
    });
    expect(await outboxRowsFor(app, uuidv7())).toEqual([]);
  });
});
