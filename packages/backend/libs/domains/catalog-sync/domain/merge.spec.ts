import fc from 'fast-check';
import type { SyncOp } from '@marketplace-sandbox/contracts';
import { encodeHlc } from './hlc';
import {
  decideFields,
  emptyModel,
  foldOps,
  stockDeltaOf,
  type ModelState,
} from './sync-merge';

const clock = (physical: number, logical: number, node: string) =>
  encodeHlc({ physical, logical, node });
const OP = (n: number) =>
  `0190f3a2-7b1c-7a55-9c3e-${String(n).padStart(12, '0')}`;
const PRODUCT = '2f1c7a3e-4d5b-4c6d-8e7f-0a1b2c3d4e5f';

const edit = (
  n: number,
  hlc: string,
  fields: Extract<SyncOp, { type: 'product.update' }>['fields'],
): SyncOp => ({
  type: 'product.update',
  opId: OP(n),
  hlc,
  productId: PRODUCT,
  fields,
});

describe('offline merge rules', () => {
  describe('per-field decision', () => {
    it('S09 AS-15: the newer clock wins its own field only', () => {
      const stored = {
        title: clock(2_000, 0, 'dev-b'),
        priceMinor: clock(500, 0, 'dev-b'),
      };
      expect(
        decideFields(['title', 'priceMinor'], clock(1_000, 0, 'dev-a'), stored),
      ).toEqual({ win: ['priceMinor'], lose: ['title'] });
    });

    it('S09 AS-15: a field with no stored clock is won by any edit', () => {
      expect(decideFields(['title'], clock(1, 0, 'dev-a'), {})).toEqual({
        win: ['title'],
        lose: [],
      });
    });

    it('S09 AS-17: an exactly equal clock loses', () => {
      const same = clock(1_000, 4, 'dev-a');
      expect(decideFields(['title'], same, { title: same })).toEqual({
        win: [],
        lose: ['title'],
      });
    });

    it.each([
      ['dev-a first', ['a', 'b']],
      ['dev-b first', ['b', 'a']],
    ])(
      'S09 AS-17: same physical time and counter, the greater node wins (%s)',
      (_name, order) => {
        const ops: Record<string, SyncOp> = {
          a: edit(1, clock(1_000, 3, 'dev-a'), { title: 'from a' }),
          b: edit(2, clock(1_000, 3, 'dev-b'), { title: 'from b' }),
        };
        const state = foldOps(
          emptyModel(10),
          order.map((key) => ops[key]),
        );
        expect(state.fields.title?.value).toBe('from b');
      },
    );

    it('S09 AS-16: a mixed edit applies only its newer field', () => {
      const first = edit(1, clock(5_000, 0, 'dev-a'), { title: 'new' });
      const mixed = edit(2, clock(3_000, 0, 'dev-b'), {
        title: 'old',
        description: 'd',
      });
      const state = foldOps(emptyModel(0), [first, mixed]);
      expect(state.fields.title?.value).toBe('new');
      expect(state.fields.description?.value).toBe('d');
    });
  });

  describe('stock deltas', () => {
    it('S09 AS-06: a count is counted minus what the device saw', () => {
      expect(
        stockDeltaOf({
          type: 'stock.count',
          opId: OP(1),
          hlc: clock(1, 0, 'dev-a'),
          productId: PRODUCT,
          counted: 8,
          base: 10,
        }),
      ).toBe(-2);
      expect(
        stockDeltaOf({
          type: 'stock.adjust',
          opId: OP(2),
          hlc: clock(1, 0, 'dev-a'),
          productId: PRODUCT,
          delta: -5,
          reason: 'sold',
        }),
      ).toBe(-5);
    });

    it('S09 AS-54: a duplicate operation counts once', () => {
      const sale: SyncOp = {
        type: 'stock.adjust',
        opId: OP(1),
        hlc: clock(1, 0, 'dev-a'),
        productId: PRODUCT,
        delta: -1,
        reason: 'sold',
      };
      expect(foldOps(emptyModel(10), [sale, sale, sale]).quantity).toBe(9);
    });
  });

  describe('convergence', () => {
    const NODES = ['dev-a', 'dev-b', 'dev-c'];
    const operation = fc.record({
      node: fc.constantFrom(...NODES),
      physical: fc.integer({ min: 1_000, max: 1_020 }),
      kind: fc.constantFrom('adjust', 'count', 'title', 'price', 'both'),
      amount: fc.integer({ min: 1, max: 50 }),
      text: fc.constantFrom('x', 'y', 'z'),
    });

    const operations = fc
      .array(operation, { minLength: 1, maxLength: 14 })
      .map((raws) =>
        raws.map((raw, index): SyncOp => {
          const hlc = clock(raw.physical, index, raw.node);
          const base = { opId: OP(index + 1), hlc, productId: PRODUCT };
          switch (raw.kind) {
            case 'adjust':
              return {
                ...base,
                type: 'stock.adjust',
                delta: raw.amount % 2 ? raw.amount : -raw.amount,
                reason: 'other',
              };
            case 'count':
              return {
                ...base,
                type: 'stock.count',
                counted: raw.amount,
                base: raw.amount + 3,
              };
            case 'title':
              return {
                ...base,
                type: 'product.update',
                fields: { title: raw.text },
              };
            case 'price':
              return {
                ...base,
                type: 'product.update',
                fields: { priceMinor: raw.amount },
              };
            default:
              return {
                ...base,
                type: 'product.update',
                fields: { title: raw.text, priceMinor: raw.amount },
              };
          }
        }),
      );

    it('S09 AS-54: any arrival order, with every operation duplicated, ends in the same state (1,000 runs)', () => {
      fc.assert(
        fc.property(
          operations.chain((ops) =>
            fc
              .tuple(
                fc.shuffledSubarray([...ops, ...ops], {
                  minLength: ops.length * 2,
                  maxLength: ops.length * 2,
                }),
                fc.shuffledSubarray(ops, {
                  minLength: ops.length,
                  maxLength: ops.length,
                }),
              )
              .map(([arrival, other]) => ({ ops, arrival, other })),
          ),
          ({ ops, arrival, other }) => {
            const reference: ModelState = foldOps(emptyModel(1_000), ops);
            expect(foldOps(emptyModel(1_000), arrival)).toEqual(reference);
            expect(foldOps(emptyModel(1_000), other)).toEqual(reference);
          },
        ),
        { numRuns: 1_000 },
      );
    });
  });
});
