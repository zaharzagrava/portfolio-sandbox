import { INestApplication, Module } from '@nestjs/common';
import {
  getConnectionToken,
  getModelToken,
  SequelizeModule,
} from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { v4 } from 'uuid';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { TableName } from '@app/test/seeds/types';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { ShopModel as Shop } from '@app/domains/tenancy';
import { ShopFunctionsModule } from './shop-functions.module';
import { ShopFunctionsService } from './application/shop-functions.service';

@Module({ imports: [ShopFunctionsModule, SequelizeModule.forFeature([Shop])] })
class SpecModule {}

const THIRD_HALF_OFF = `
  function run(input) {
    // "Buy 2 cases, the 3rd is half price": a per-unit discount of 1/6 of the price on lines with 3+ units.
    return { discounts: input.lines.map((l, i) => l.category === 'cases' && l.quantity >= 3 ? { lineIndex: i, type: 'fixedPerUnit', value: Math.floor(l.unitPrice / 6), message: '3rd case 50% off' } : null).filter(Boolean) };
  }`;
const caseInput = (quantity: number) => ({
  currency: 'usd',
  lines: [{ productId: 'p', category: 'cases', quantity, unitPrice: 1_200 }],
});

/** SD-40 against real Postgres + Redis + real V8 isolates. */
describe('Shop functions (e2e)', () => {
  let app: INestApplication;
  let seeds: SeedsService;
  let fns: ShopFunctionsService;
  let db: Sequelize;

  beforeAll(async () => {
    const moduleRef = await generateTestingModule([SpecModule, SeedsModule], {
      stores: ['redis', 'sqs'],
    });
    app = moduleRef.createNestApplication();
    await app.init();
    seeds = app.get(SeedsService);
    fns = app.get(ShopFunctionsService);
    db = app.get(getConnectionToken());
    jest.spyOn(app.get(TaskQueue), 'enqueue').mockResolvedValue('m');
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seeds.clean();
    const redis = app.get(RedisService).client;
    const keys = await redis.keys('fn:*');
    if (keys.length) await redis.del(...keys);
  });

  const setup = async () => {
    const shop = await app
      .get<typeof Shop>(getModelToken(Shop))
      .create({ name: 'Cases R Us', slug: `c-${v4().slice(0, 8)}` });
    const [user] = await seeds.createTreelike([{ __type__: TableName.User }]);
    const { functionId } = await fns.create(shop.id, 'third-case-half-off', [
      {
        name: 'a 3 cases',
        input: caseInput(3),
        expected: {
          discounts: [
            {
              lineIndex: 0,
              type: 'fixedPerUnit',
              value: 200,
              message: '3rd case 50% off',
            },
          ],
        },
      },
      { name: 'b 2 cases', input: caseInput(2), expected: { discounts: [] } },
    ]);
    return { shopId: shop.id, userId: user.id as string, functionId };
  };

  it('judge: passing code becomes ACTIVE; an infinite loop and Node API access are REJECTED with per-case verdicts', async () => {
    const { shopId, userId, functionId } = await setup();
    const good = await fns.submit(shopId, functionId, userId, THIRD_HALF_OFF);
    expect(await fns.judge(functionId, good.version)).toMatchObject({
      status: 'ACTIVE',
    });

    const loop = await fns.submit(
      shopId,
      functionId,
      userId,
      'function run() { while (true) {} }',
    );
    const looped = await fns.judge(functionId, loop.version);
    expect(looped).toMatchObject({
      status: 'REJECTED',
      verdicts: [{ verdict: 'timeout' }, { verdict: 'timeout' }],
    });

    const sneaky = await fns.submit(
      shopId,
      functionId,
      userId,
      "function run() { require('fs').readFileSync('/etc/passwd'); return { discounts: [] }; }",
    );
    expect(
      (await fns.judge(functionId, sneaky.version))?.verdicts[0],
    ).toMatchObject({
      verdict: 'runtime',
      detail: expect.stringMatching(/require is not defined/),
    });

    const [{ activeVersion }] = await db.query<{ activeVersion: number }>(
      `SELECT "activeVersion" FROM "ShopFunction" WHERE id = :functionId`,
      { type: QueryTypes.SELECT, replacements: { functionId } },
    );
    expect(activeVersion).toBe(good.version); // rejected versions never replace the active one
  });

  it("checkout: the active function discounts only its own shop's lines", async () => {
    const { shopId, userId, functionId } = await setup();
    await fns.judge(
      functionId,
      (await fns.submit(shopId, functionId, userId, THIRD_HALF_OFF)).version,
    );
    const prices = await fns.unitPrices([
      {
        productId: 'a',
        shopId,
        category: 'cases',
        quantity: 3,
        unitPrice: 1_200,
      },
      {
        productId: 'b',
        shopId: v4(),
        category: 'cases',
        quantity: 3,
        unitPrice: 1_200,
      }, // another shop's line
    ]);
    expect(prices).toEqual([1_000, 1_200]);
  });

  it('fail-safe: a function that errors at checkout charges catalogue price and trips its breaker', async () => {
    const { shopId, userId, functionId } = await setup();
    // Passes its tests (2 cases) but throws on a cart shape the seller didn't test.
    const flaky = `function run(input) { if (input.lines[0].quantity > 5) throw new Error('boom'); return { discounts: input.lines[0].quantity >= 3 ? [{ lineIndex: 0, type: 'fixedPerUnit', value: 200, message: '3rd case 50% off' }] : [] }; }`;
    await fns.judge(
      functionId,
      (await fns.submit(shopId, functionId, userId, flaky)).version,
    );
    for (let i = 0; i < 5; i++)
      expect(
        await fns.unitPrices([
          {
            productId: `x${i}`,
            shopId,
            category: 'cases',
            quantity: 9,
            unitPrice: 1_200,
          },
        ]),
      ).toEqual([1_200]);
    expect(
      await app.get(RedisService).client.exists(`fn:breaker:${functionId}`),
    ).toBe(1);
  });
});
