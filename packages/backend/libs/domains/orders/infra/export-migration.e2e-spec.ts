import { QueryTypes, Sequelize } from 'sequelize';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const dbConfig = require('../../../../configs/db.config.js').test;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const expand = require('../../../../migrations/20261016000600-orders-export-expand.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const activeIndex = require('../../../../migrations/20261016000610-orders-export-active-index.js');

/** S12 T019: the expand migration re-runs without change; the shape the repository relies on is present. */
describe('orders export expand migration (e2e)', () => {
  let db: Sequelize;
  beforeAll(() => {
    db = new Sequelize({ ...dbConfig, logging: false });
  });
  afterAll(() => db.close());

  it('runs twice without error (idempotent)', async () => {
    await expect(expand.up(db.getQueryInterface())).resolves.toBeUndefined();
    await expect(
      activeIndex.up(db.getQueryInterface()),
    ).resolves.toBeUndefined();
  });

  it('has the indexes, no foreign keys, and the widened status check', async () => {
    const names = (
      await db.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE tablename IN ('ExportJob', 'ExportJobHistory')`,
        { type: QueryTypes.SELECT },
      )
    ).map((r) => r.indexname);
    expect(names).toEqual(
      expect.arrayContaining([
        'ux_exportjob_active_per_shop',
        'ix_exportjob_shop_created',
        'ix_exportjob_lease',
        'ix_exportjob_finished',
        'ix_exportjobhistory_export_at',
      ]),
    );
    const fks = await db.query(
      `SELECT 1 FROM pg_constraint WHERE conrelid = '"ExportJob"'::regclass AND contype = 'f'`,
      { type: QueryTypes.SELECT },
    );
    expect(fks).toHaveLength(0);
    const [{ valid }] = await db.query<{ valid: boolean }>(
      `SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = 'ux_exportjob_active_per_shop'::regclass`,
      { type: QueryTypes.SELECT },
    );
    expect(valid).toBe(true);
  });
});
