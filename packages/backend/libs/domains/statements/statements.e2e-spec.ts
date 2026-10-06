import { INestApplication } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import { Writable } from 'node:stream';
import { v4 } from 'uuid';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { TableName } from '@app/test/seeds/types';
import { ShopModel as Shop } from '@app/domains/tenancy';
import { StatementsModule } from './statements.module';
import { StatementService } from './application/statement.service';
import { CommissionRateService } from './application/commission-rate.service';
import { ReportingPool } from './infra/reporting-pool';
import { streamStatementCsv } from './infra/statement-export';

/** SD-41 against the real test Postgres (tstzrange, GiST exclusion constraint, LATERAL as-of lookups). */
describe('Statements & bitemporal commission rates (e2e)', () => {
  let app: INestApplication;
  let seeds: SeedsService;
  let sequelize: Sequelize;
  let statements: StatementService;
  let rates: CommissionRateService;
  let shopId: string;

  beforeAll(async () => {
    const moduleRef = await generateTestingModule([StatementsModule, SeedsModule]);
    app = moduleRef.createNestApplication();
    await app.init();
    seeds = app.get(SeedsService);
    sequelize = app.get(getConnectionToken());
    statements = app.get(StatementService);
    rates = app.get(CommissionRateService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await sequelize.query(`TRUNCATE "StatementSnapshot", "StatementAdjustment", "AccountingPeriod"`);
    await sequelize.query(`DELETE FROM "CommissionRate" WHERE reason <> 'initial default'`);
    await sequelize.query(`UPDATE "CommissionRate" SET "recordedPeriod" = tstzrange('-infinity', NULL)`);
    await seeds.clean();
    shopId = (await app.get<typeof Shop>(getModelToken(Shop)).create({ name: 'S', slug: `s-${v4().slice(0, 8)}` })).id;

    const [product] = await seeds.createTreelike([{ __type__: TableName.Product, category: 'electronics', shopId }]);
    const [formula] = await seeds.createTreelike([{ __type__: TableName.Product, category: '=HYPERLINK("http://evil")', shopId }]);
    const [user] = await seeds.createTreelike([{ __type__: TableName.User, email: `u-${v4()}@mail.com` }]);
    for (const [productId, price] of [
      [product.id, 10_000],
      [product.id, 20_000],
      [formula.id, 500],
    ] as const) {
      const [order] = await seeds.createTreelike([{ __type__: TableName.BisOrder, userId: user.id }]);
      await sequelize.query(`UPDATE "BisOrder" SET status = 'PAID', "createdAt" = '2026-03-15T12:00:00Z' WHERE id = :id`, { replacements: { id: order.id } });
      await sequelize.query(
        `INSERT INTO "BisOrderItem" (id, "bisOrderId", "productId", quantity, "priceAtPurchase", "shopId", "createdAt", "updatedAt") VALUES (uuidv7(), :o, :p, 1, :price, :shop, now(), now())`,
        { replacements: { o: order.id, p: productId, price, shop: shopId } },
      );
    }
  });

  it('closed months never change: a retroactive rate cut becomes an adjustment; "as known at" still answers the old truth', async () => {
    const live = await statements.statement(shopId, '2026-03-01');
    expect(live).toMatchObject({ source: 'live', gross: 30_500, commission: 3_050 }); // 10% default

    await statements.closeMonth('2026-03-01');
    const beforeChange = new Date();
    await new Promise((r) => setTimeout(r, 20));

    // In April finance decides: this shop's electronics fee is 7% since March 1st.
    await rates.setRate({ shopId, category: 'electronics', rateBps: 700, validFrom: new Date('2026-03-01T00:00:00Z'), reason: 'promo-2026-03' });
    await statements.retroAdjust({ shopKey: shopId, from: '2026-03-01T00:00:00Z', to: null, reason: 'promo-2026-03' });
    await statements.retroAdjust({ shopKey: shopId, from: '2026-03-01T00:00:00Z', to: null, reason: 'promo-2026-03' }); // job retry

    const closed = await statements.statement(shopId, '2026-03-01');
    expect(closed.source).toBe('snapshot');
    expect(closed.commission).toBe(3_050); // untouched
    expect(closed.adjustments).toEqual([expect.objectContaining({ commissionDelta: -900 })]); // 30_000 × 3%

    expect((await statements.statement(shopId, '2026-03-01', beforeChange)).commission).toBe(3_050);
    expect((await statements.statement(shopId, '2026-03-01', new Date())).commission).toBe(2_150);
  });

  it('bitemporal history: the superseded belief is kept with a closed recorded period', async () => {
    await rates.setRate({ category: 'electronics', rateBps: 800, validFrom: new Date('2026-01-01T00:00:00Z'), reason: 'electronics default' });
    const t1 = new Date();
    await new Promise((r) => setTimeout(r, 20));
    await rates.setRate({ category: 'electronics', rateBps: 750, validFrom: new Date('2026-06-01T00:00:00Z'), reason: 'summer cut' });

    const history = await rates.history(null, 'electronics');
    expect(history.filter((h) => h.recordedTo !== null)).toHaveLength(1); // the 8% belief from Jan, superseded
    expect(await rates.rateAsOf(v4(), 'electronics', new Date('2026-07-01'), t1)).toBe(800);
    expect(await rates.rateAsOf(v4(), 'electronics', new Date('2026-07-01'))).toBe(750);
    expect(await rates.rateAsOf(v4(), 'electronics', new Date('2026-03-01'))).toBe(800);
  });

  it('the database rejects two current rates with overlapping validity (exclusion constraint)', async () => {
    await expect(
      sequelize.query(
        `INSERT INTO "CommissionRate" ("shopKey", category, "rateBps", "validPeriod") VALUES (:shop, 'x', 100, tstzrange('2026-01-01', '2026-03-01')), (:shop, 'x', 200, tstzrange('2026-02-01', NULL))`,
        { replacements: { shop: shopId } },
      ),
    ).rejects.toMatchObject({ name: 'SequelizeExclusionConstraintError', constraint: 'CommissionRate_no_overlap_current' });
  });

  it('CSV export streams rows and neutralizes spreadsheet formula injection', async () => {
    let csv = '';
    const sink = new Writable({
      write(chunk, _enc, done) {
        csv += chunk.toString();
        done();
      },
    });
    await streamStatementCsv(app.get(ReportingPool).pool, shopId, '2026-03-01', sink);

    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('orderId,orderedAt,productId,category,quantity,unitPrice,lineTotal');
    expect(lines).toHaveLength(4);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);
  });
});
