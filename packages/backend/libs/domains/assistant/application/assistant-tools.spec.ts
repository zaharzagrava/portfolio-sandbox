import { v4 } from 'uuid';
import {
  ASSISTANT_TOOLS,
  ASSISTANT_TOOL_NAMES,
  AssistantToolCatalog,
} from './assistant-tools';

const calls: string[] = [];
const catalog = new AssistantToolCatalog(
  {
    search: async () => (
      calls.push('search'),
      { items: [], total: { value: 0 } }
    ),
  } as never,
  { getProductsByIds: async () => (calls.push('details'), new Map()) } as never,
  { searchNear: async () => (calls.push('pickup'), { items: [] }) } as never,
  { get: () => 1_000 } as never,
);
const context = {
  messageId: 'm',
  userId: 'u',
  conversationId: 'c',
  signal: new AbortController().signal,
};

describe('assistant tools: input schemas and the closed allowlist', () => {
  beforeEach(() => (calls.length = 0));

  it('S46 AS-19: exactly three tools, none with a free-form URL or recipient field', () => {
    expect(ASSISTANT_TOOL_NAMES).toEqual([
      'search_products',
      'product_details',
      'pickup_near_me',
    ]);
    expect(catalog.definitions().map((d) => d.name)).toEqual(
      ASSISTANT_TOOL_NAMES,
    );
    const forbidden =
      /url|link|email|recipient|address|phone|lat|lng|latitude|longitude|user|order|cart/i;
    for (const tool of ASSISTANT_TOOLS) {
      const schema = tool.input_schema as unknown as {
        properties: Record<string, unknown>;
        additionalProperties: boolean;
      };
      expect(schema.additionalProperties).toBe(false);
      for (const field of Object.keys(schema.properties))
        expect(field).not.toMatch(forbidden);
    }
  });

  const invalid: [string, string, Record<string, unknown>, string][] = [
    [
      'search_products',
      'empty query',
      { query: '', max_price: null, category: null, limit: null },
      'query',
    ],
    [
      'search_products',
      'negative price',
      { query: 'x', max_price: -1, category: null, limit: null },
      'max_price',
    ],
    [
      'search_products',
      'fractional price',
      { query: 'x', max_price: 10.5, category: null, limit: null },
      'max_price',
    ],
    [
      'search_products',
      'limit 0',
      { query: 'x', max_price: null, category: null, limit: 0 },
      'limit',
    ],
    [
      'search_products',
      'limit 11',
      { query: 'x', max_price: null, category: null, limit: 11 },
      'limit',
    ],
    [
      'search_products',
      'query too long',
      { query: 'x'.repeat(201), max_price: null, category: null, limit: null },
      'query',
    ],
    [
      'search_products',
      'missing fields',
      { query: 'x' },
      'max_price, category, limit',
    ],
    [
      'search_products',
      'extra field',
      { query: 'x', max_price: null, category: null, limit: null, shop: 's' },
      'shop',
    ],
    ['product_details', 'not a uuid', { product_id: 'abc' }, 'product_id'],
    ['product_details', 'extra field', { product_id: v4(), user: 'u' }, 'user'],
    ['pickup_near_me', 'radius 0', { query: 'x', radius_km: 0 }, 'radius_km'],
    ['pickup_near_me', 'radius 51', { query: 'x', radius_km: 51 }, 'radius_km'],
    [
      'pickup_near_me',
      'coordinates supplied by the model',
      { query: 'x', radius_km: null, lat: 1, lng: 2 },
      'lat, lng',
    ],
    ['pickup_near_me', 'empty query', { query: '', radius_km: null }, 'query'],
  ];

  it.each(invalid)(
    'S46 AS-15: %s, %s is rejected before any service is called',
    async (name, _case, input, fields) => {
      const result = await catalog.execute(name, input, {
        ...context,
        location: { lat: 1, lng: 2 },
      });
      expect(result).toEqual({ ok: false, error: `Invalid input: ${fields}.` });
      expect(calls).toEqual([]);
    },
  );

  it('S46 AS-15: an unknown tool is never executed', async () => {
    expect(await catalog.execute('place_order', {}, context)).toEqual({
      ok: false,
      error: 'Unknown tool.',
    });
    expect(calls).toEqual([]);
  });

  it('S46 AS-15: valid input reaches the owning service', async () => {
    await catalog.execute(
      'search_products',
      { query: 'x', max_price: 100, category: null, limit: 10 },
      context,
    );
    await catalog.execute('product_details', { product_id: v4() }, context);
    await catalog.execute(
      'pickup_near_me',
      { query: 'x', radius_km: 50 },
      { ...context, location: { lat: 1, lng: 2 } },
    );
    expect(calls).toEqual(['search', 'details', 'pickup']);
  });
});
