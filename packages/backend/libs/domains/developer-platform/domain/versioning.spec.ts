import fc from 'fast-check';
import {
  assertVersionRegistryValid,
  downgradeResource,
  downgradeResponse,
  resolveVersion,
  upgradeProductWrite,
} from './versioning';
import {
  LATEST_VERSION,
  VERSION_REGISTRY,
  VersionChange,
  VersionEntry,
} from './version-registry';

const money = (amount: number, currency = 'USD') => ({ amount, currency });
const product = {
  id: 'p1',
  object: 'product',
  title: 'Mug',
  price: money(1999),
  stock: 7,
  brand: 'Acme',
};
const order = {
  id: 'o1',
  object: 'order',
  status: 'paid',
  total: money(5000, 'EUR'),
  lines: [{ product_id: 'p1', quantity: 2, unit_price: money(2500, 'EUR') }],
};

describe('S42 versioning (FR-024…FR-029)', () => {
  describe('resolution order (AS-27)', () => {
    it.each<[string, string | undefined, string | undefined, string]>([
      ['header wins over pin', '2026-01-15', '2026-10-01', '2026-01-15'],
      ['pin when no header', undefined, '2026-01-15', '2026-01-15'],
      ['latest when neither', undefined, undefined, LATEST_VERSION],
    ])('%s', (_n, header, pin, expected) => {
      expect(resolveVersion({ header, pin })).toBe(expected);
    });

    it.each(['', '2026-13-01', 'latest', '2020-01-01', '2026-1-5'])(
      'refuses %p with 400 invalid_version',
      (header) => {
        expect(() => resolveVersion({ header, pin: undefined })).toThrow(
          expect.objectContaining({ code: 'invalid_version', status: 400 }),
        );
      },
    );
  });

  describe('downgrade, every change × resource (AS-28)', () => {
    it('is the identity at the latest version', () => {
      expect(downgradeResource('product', product, LATEST_VERSION)).toEqual(
        product,
      );
    });

    it('product at 2026-01-15: integer price, quantity instead of stock', () => {
      expect(downgradeResource('product', product, '2026-01-15')).toEqual({
        id: 'p1',
        object: 'product',
        title: 'Mug',
        price: 1999,
        quantity: 7,
        brand: 'Acme',
      });
    });

    it('order at 2026-01-15: integer total, top-level currency, integer unit_price', () => {
      expect(downgradeResource('order', order, '2026-01-15')).toEqual({
        id: 'o1',
        object: 'order',
        status: 'paid',
        total: 5000,
        currency: 'EUR',
        lines: [{ product_id: 'p1', quantity: 2, unit_price: 2500 }],
      });
    });

    it('list: transforms every item and keeps the envelope', () => {
      const list = {
        object: 'list',
        data: [product],
        has_more: false,
        next_cursor: null,
      };
      expect(downgradeResponse('list', list, '2026-01-15', 'product')).toEqual({
        object: 'list',
        data: [downgradeResource('product', product, '2026-01-15')],
        has_more: false,
        next_cursor: null,
      });
    });
  });

  describe('request upgrade (AS-29)', () => {
    it('old product write: integer price → money object in the given currency, quantity → stock, brand defaults to Unbranded', () => {
      expect(
        upgradeProductWrite(
          { title: 'Mug', price: 1999, quantity: 3 },
          '2026-01-15',
          { currency: 'USD' },
        ),
      ).toEqual({
        title: 'Mug',
        price: money(1999),
        stock: 3,
        brand: 'Unbranded',
      });
    });

    it('keeps a brand that is sent', () => {
      expect(
        upgradeProductWrite(
          { title: 'Mug', price: 1, brand: 'Acme' },
          '2026-01-15',
          { currency: 'USD' },
        ),
      ).toMatchObject({ brand: 'Acme' });
    });

    it('is the identity at the latest version', () => {
      const body = { title: 'Mug', price: money(5), brand: 'A' };
      expect(
        upgradeProductWrite(body, LATEST_VERSION, { currency: 'USD' }),
      ).toEqual(body);
    });

    it('property: upgrade(downgrade(p)) restores price and stock', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 100_000_000 }),
          fc.integer({ min: 0, max: 1_000_000 }),
          fc.constantFrom('USD', 'EUR', 'GBP'),
          (amount, stock, currency) => {
            const p = { ...product, price: money(amount, currency), stock };
            const down = downgradeResource('product', p, '2026-01-15');
            const up = upgradeProductWrite(down, '2026-01-15', { currency });
            return (
              JSON.stringify(up.price) === JSON.stringify(p.price) &&
              up.stock === p.stock
            );
          },
        ),
      );
    });
  });

  describe('S42 AS-31 registry validation', () => {
    const entry = (version: string, over: Partial<VersionEntry> = {}) =>
      ({
        ...VERSION_REGISTRY[VERSION_REGISTRY.length - 1],
        version,
        ...over,
      }) as VersionEntry;

    it('the shipped registry is valid', () => {
      expect(() => assertVersionRegistryValid(VERSION_REGISTRY)).not.toThrow();
    });

    it('refuses a registry that is not ordered ascending', () => {
      expect(() =>
        assertVersionRegistryValid([...VERSION_REGISTRY].reverse()),
      ).toThrow(/order/);
    });

    it('refuses duplicates', () => {
      expect(() =>
        assertVersionRegistryValid([
          ...VERSION_REGISTRY,
          entry(VERSION_REGISTRY[VERSION_REGISTRY.length - 1].version),
        ]),
      ).toThrow(/order|duplicate/);
    });

    it('refuses a retired latest version', () => {
      const last = VERSION_REGISTRY[VERSION_REGISTRY.length - 1];
      expect(() =>
        assertVersionRegistryValid([
          ...VERSION_REGISTRY.slice(0, -1),
          { ...last, lifecycle: { status: 'retired' } },
        ]),
      ).toThrow(/latest/);
    });

    it('refuses a version whose change cannot downgrade a resource', () => {
      const last = VERSION_REGISTRY[VERSION_REGISTRY.length - 1];
      expect(() =>
        assertVersionRegistryValid([
          ...VERSION_REGISTRY,
          entry('2099-01-01', {
            change: {
              ...last.change!,
              downgrade: {
                product: last.change!.downgrade.product,
              } as unknown as VersionChange['downgrade'],
            },
          }),
        ]),
      ).toThrow(/downgrade/);
    });

    it('compares versions as ISO date strings', () => {
      expect('2026-10-01' > '2026-01-15').toBe(true);
    });
  });
});
