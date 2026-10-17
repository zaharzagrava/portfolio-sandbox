import {
  GOOD_SOURCE,
  THROW_SOURCE,
  cartOf,
  createFunctionsApp,
  type FunctionsTestApp,
  type SeededShop,
} from './testing/function-fixtures';

/** The end-to-end journey across the module; each step has its detailed spec in the sibling files. */
describe('Shop functions (e2e journey)', () => {
  let t: FunctionsTestApp;
  let A: SeededShop;

  beforeAll(async () => {
    t = await createFunctionsApp();
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    A = await t.seedShop();
  });

  const statusOf = async (fn: string) =>
    (
      await t.pg<{ status: string }>(
        `SELECT "status" FROM "ShopFunctionVersion" WHERE "functionId" = :fn ORDER BY "version"`,
        { fn },
      )
    ).map((r) => r.status);

  it('S45 AS-10: a submitted version is judged and becomes ACTIVE', async () => {
    const fn = await t.newFunction(A.admin, A.shopId);

    const res = await t.submit(A.admin, A.shopId, fn, GOOD_SOURCE);
    expect(res.status).toBe(202);
    expect(await statusOf(fn)).toEqual(['QUEUED']);

    await t.judge(fn);
    expect(await statusOf(fn)).toEqual(['ACTIVE']);
  });

  it("S45 AS-24: the active function discounts only its own shop's lines at checkout", async () => {
    const S2 = await t.seedShop();
    await t.seedActive(A.shopId, { source: GOOD_SOURCE });

    const own = await t.evaluate(cartOf(A.shopId));
    const other = await t.evaluate(cartOf(S2.shopId));

    expect(own.shopDiscounts).toHaveLength(1);
    expect(own.shopDiscounts[0].shopId).toBe(A.shopId);
    expect(own.shopDiscounts[0].discountMinor).toBeGreaterThan(0);
    expect(other).toEqual({ shopDiscounts: [] });
  });

  it('S45 AS-28: a function that errors at checkout gives no discount instead of failing the cart', async () => {
    await t.seedActive(A.shopId, { source: THROW_SOURCE });

    const result = await t.evaluate(cartOf(A.shopId));

    expect(result).toEqual({ shopDiscounts: [] });
  });
});
