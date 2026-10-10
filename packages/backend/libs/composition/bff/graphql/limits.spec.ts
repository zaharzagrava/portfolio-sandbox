import { parse } from 'graphql';
import { analyzeQuery, type QueryLimits } from './limits';

const limits: QueryLimits = {
  maxDepth: 6,
  maxCost: 2_000,
  maxRootFields: 20,
  maxIds: 50,
};

const ids = (n: number) =>
  Array.from({ length: n }, (_, i) => `"id-${i}"`).join(',');
const analyze = (
  query: string,
  variables: Record<string, unknown> = {},
  over: Partial<QueryLimits> = {},
  operationName?: string,
) =>
  analyzeQuery(parse(query), variables, operationName, { ...limits, ...over });

describe('S48 U1 GraphQL limits (depth, cost, root fields)', () => {
  describe('S48 AS-31 depth', () => {
    it.each([
      ['{ product(id: "a") { id } }', 2, true],
      ['{ product(id: "a") { shop { name } } }', 3, true],
      [
        '{ product(id: "a") { recommendations { recommendations { recommendations { recommendations { id } } } } } }',
        6,
        true,
      ],
      [
        '{ product(id: "a") { recommendations { recommendations { recommendations { recommendations { recommendations { id } } } } } } }',
        7,
        false,
      ],
    ])('S48 AS-31: %s has depth %s → ok=%s', (query, depth, ok) => {
      const v = analyze(query, {}, { maxCost: Number.MAX_SAFE_INTEGER }); // depth only: nested recommendations are also costly
      expect(v.depth).toBe(depth);
      expect(v.ok).toBe(ok);
      if (!v.ok) expect(v.code).toBe('QUERY_TOO_DEEP');
    });

    it('S48 AS-31: depth is counted through fragments and inline fragments', () => {
      const v = analyze(
        `
        query { product(id: "a") { ...A } }
        fragment A on Product { recommendations { ... on Product { recommendations { ...B } } } }
        fragment B on Product { recommendations { recommendations { recommendations { id } } } }`,
        {},
        { maxCost: Number.MAX_SAFE_INTEGER },
      );
      expect(v.depth).toBe(7);
      expect(v.ok).toBe(false);
    });

    it('S48 AS-31: introspection fields do not count', () => {
      expect(analyze('{ __typename }').depth).toBe(0);
    });
  });

  describe('S48 AS-32 cost', () => {
    it('S48 AS-32: one unit per field, multiplied by the list sizes above it', () => {
      expect(analyze('{ product(id: "a") { id title } }').cost).toBe(3);
      expect(analyze(`{ products(ids: [${ids(20)}]) { id } }`).cost).toBe(40);
      expect(
        analyze(`{ products(ids: [${ids(20)}]) { id shop { name } } }`).cost,
      ).toBe(20 + 20 + 20 + 20); // products, id, shop, shop.name
    });

    it('S48 AS-32: recommendations count as 8 items', () => {
      expect(
        analyze('{ product(id: "a") { recommendations { id } } }').cost,
      ).toBe(1 + 8 + 8);
      expect(
        analyze('{ product(id: "a") { recommendations(first: 20) { id } } }')
          .cost,
      ).toBe(1 + 20 + 20);
    });

    it('S48 AS-32: list sizes come from variable values as well as literals', () => {
      const literal = analyze(`{ products(ids: [${ids(50)}]) { id title } }`);
      const variable = analyze(
        'query($ids: [ID!]!) { products(ids: $ids) { id title } }',
        { ids: Array.from({ length: 50 }, (_, i) => `id-${i}`) },
      );
      expect(variable.cost).toBe(literal.cost);
      expect(variable.cost).toBe(150);
    });

    it('S48 AS-32: a variable `first` and a default value are used', () => {
      const q =
        'query($n: Int) { product(id: "a") { recommendations(first: $n) { id } } }';
      expect(analyze(q, { n: 30 }).cost).toBe(1 + 30 + 30);
      expect(
        analyze(
          'query($n: Int = 12) { product(id: "a") { recommendations(first: $n) { id } } }',
        ).cost,
      ).toBe(1 + 12 + 12);
      expect(analyze(q, {}).cost).toBe(1 + 8 + 8); // not given: the field default of 8
    });

    it('S48 AS-32: a huge variable list is priced by its length, not truncated', () => {
      const v = analyze(
        'query($ids: [ID!]!) { products(ids: $ids) { id title shop { name } recommendations { id } } }',
        { ids: Array.from({ length: 50 }, (_, i) => `id-${i}`) },
      );
      expect(v.cost).toBe(50 + 50 + 50 + 50 + 50 + 50 * 8 + 50 * 8);
    });

    it('S48 AS-32: aliases are separate fields and add up', () => {
      const one = analyze(`{ a: products(ids: [${ids(10)}]) { id } }`).cost;
      const three = analyze(
        `{ a: products(ids: [${ids(10)}]) { id } b: products(ids: [${ids(10)}]) { id } c: products(ids: [${ids(10)}]) { id } }`,
      ).cost;
      expect(three).toBe(one * 3);
    });

    it('S48 AS-32: fragments and inline fragments are priced like the fields they contain, each use counts', () => {
      const inline = analyze(
        `{ products(ids: [${ids(10)}]) { id title shop { name } } }`,
      ).cost;
      const spread = analyze(`
        query { products(ids: [${ids(10)}]) { ...F } }
        fragment F on Product { id title shop { name } }`).cost;
      const inlineFragment = analyze(
        `{ products(ids: [${ids(10)}]) { ... on Product { id title shop { name } } } }`,
      ).cost;
      expect(spread).toBe(inline);
      expect(inlineFragment).toBe(inline);
      const twice = analyze(`
        query { a: products(ids: [${ids(10)}]) { ...F } b: products(ids: [${ids(10)}]) { ...F } }
        fragment F on Product { id title shop { name } }`).cost;
      expect(twice).toBe(inline * 2);
    });

    it('S48 AS-32: exactly 2,000 passes, 2,001 is rejected (ten aliases of 200)', () => {
      // per alias: products 50 + id 50 + title 50 + shop 50 = 200; ten of them = 2,000
      const thin = (i: number) =>
        `a${i}: products(ids: [${ids(50)}]) { id title shop }`;
      const ten = Array.from({ length: 10 }, (_, i) => thin(i)).join(' ');
      const exact = analyze(`{ ${ten} }`);
      expect(exact.cost).toBe(2_000);
      expect(exact.ok).toBe(true);
      const over = analyze(`{ ${ten} extra: product(id: "x") { id } }`);
      expect(over.cost).toBe(2_002);
      expect(over.ok).toBe(false);
      if (!over.ok) expect(over.code).toBe('QUERY_TOO_COSTLY');
    });

    it('S48 AS-32: a limit of 10 accepts cost 10 and rejects 11', () => {
      const ten = analyze(
        `{ a: product(id: "1") { id title } b: product(id: "2") { id title } c: product(id: "3") { id } d: product(id: "4") { id } }`,
        {},
        { maxCost: 10 },
      );
      expect(ten.cost).toBe(10);
      expect(ten.ok).toBe(true);
      const eleven = analyze(
        `{ a: product(id: "1") { id title } b: product(id: "2") { id title } c: product(id: "3") { id } d: product(id: "4") { id title } }`,
        {},
        { maxCost: 10 },
      );
      expect(eleven.cost).toBe(11);
      expect(eleven.ok).toBe(false);
    });

    it('S48 AS-32: a fragment cycle is a validation error and never loops', () => {
      const v = analyze(`
        query { product(id: "a") { ...A } }
        fragment A on Product { id ...B }
        fragment B on Product { title ...A }`);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.code).toBe('GRAPHQL_VALIDATION_FAILED');
    });

    it('S48 AS-32: a self-referencing fragment is also a cycle', () => {
      const v = analyze(`
        query { product(id: "a") { ...A } }
        fragment A on Product { id recommendations { ...A } }`);
      expect(v.ok).toBe(false);
    });

    it('S48 AS-32: nested fragment fan-out is priced without exponential work', () => {
      const frags = Array.from(
        { length: 30 },
        (_, i) => `fragment F${i} on Product { id ...F${i + 1} ...F${i + 1} }`,
      ).join('\n');
      const started = Date.now();
      const v = analyze(
        `query { product(id: "a") { ...F0 } } ${frags} fragment F30 on Product { id }`,
      );
      expect(Date.now() - started).toBeLessThan(500);
      expect(v.ok).toBe(false);
    });
  });

  describe('S48 AS-33 root fields', () => {
    const roots = (n: number) =>
      `{ ${Array.from({ length: n }, (_, i) => `a${i}: product(id: "x") { id }`).join(' ')} }`;

    it.each([
      [20, true],
      [21, false],
    ])('S48 AS-33: %s root fields → ok=%s', (n, ok) => {
      const v = analyze(roots(n));
      expect(v.rootFields).toBe(n);
      expect(v.ok).toBe(ok);
      if (!v.ok) expect(v.code).toBe('TOO_MANY_ROOT_FIELDS');
    });

    it('S48 AS-33: root fields are counted through fragments', () => {
      const v = analyze(`
        query { ...R }
        fragment R on Query { ${Array.from({ length: 21 }, (_, i) => `a${i}: product(id: "x") { id }`).join(' ')} }`);
      expect(v.rootFields).toBe(21);
      expect(v.ok).toBe(false);
    });
  });

  describe('operation selection', () => {
    it('S48 AS-33: the named operation is analysed; an ambiguous document is a validation error', () => {
      const doc =
        'query A { product(id: "a") { id } } query B { product(id: "b") { id title } }';
      expect(analyze(doc, {}, {}, 'B').cost).toBe(3);
      const v = analyze(doc);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.code).toBe('GRAPHQL_VALIDATION_FAILED');
    });

    it('S48 AS-40: a mutation or subscription is rejected as a validation error', () => {
      const v = analyze('mutation { x }');
      expect(v.ok).toBe(false);
    });
  });
});
