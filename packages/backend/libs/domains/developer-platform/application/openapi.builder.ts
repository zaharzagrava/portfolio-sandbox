import { z } from 'zod';
import {
  batchRequestSchema,
  batchResultSchema,
  bulkStockAcceptedSchema,
  bulkStockJobSchema,
  bulkStockRequestSchema,
  bulkStockSyncResultSchema,
  publicApiProblemSchema,
  publicApiV20260115,
  publicApiV20261001,
  PUBLIC_API_ERROR_CODES,
} from '@marketplace-sandbox/contracts';
import { API_ERROR_CATALOGUE } from '../domain/errors';
import { PUBLIC_ROUTES, type PublicRoute } from '../domain/public-routes';
import {
  DEPRECATED_ROUTES,
  VERSION_REGISTRY,
  apiVersions,
  latestVersion,
} from '../domain/version-registry';

type Json = Record<string, unknown>;

const schemaOf = (schema: z.ZodType): Json =>
  z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'output',
    unrepresentable: 'any',
  }) as Json;
const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` });
const versionKey = (v: string): string => v.replace(/-/g, '');

/**
 * The OpenAPI 3.1 description of both surfaces, generated from the route catalogue, the version registry, the deprecation
 * registry and the contract schemas (FR-061, FR-034, AS-36, AS-67): nothing in it is written by hand twice. Served without
 * authentication; it contains no key.
 */
export function buildOpenApi(): Json {
  const versions = apiVersions();
  const schemas: Record<string, Json> = {
    Problem: schemaOf(publicApiProblemSchema),
    CreateProduct: schemaOf(publicApiV20261001.createProductRequestSchema),
    UpdateProduct: schemaOf(publicApiV20261001.updateProductRequestSchema),
    CreateProduct_20260115: schemaOf(
      publicApiV20260115.createProductRequestSchema,
    ),
    BulkStock: schemaOf(bulkStockRequestSchema),
    BulkStockResult: schemaOf(bulkStockSyncResultSchema),
    BulkStockAccepted: schemaOf(bulkStockAcceptedSchema),
    BulkStockJob: schemaOf(bulkStockJobSchema),
    Batch: schemaOf(batchRequestSchema),
    BatchResult: schemaOf(batchResultSchema),
    Stock: schemaOf(publicApiV20261001.stockSchema),
    Product_20261001: schemaOf(publicApiV20261001.productSchema),
    Order_20261001: schemaOf(publicApiV20261001.orderSchema),
    Product_20260115: schemaOf(publicApiV20260115.productSchema),
    Order_20260115: schemaOf(publicApiV20260115.orderSchema),
  };
  // Rules the server enforces beyond the plain type (B-063): written into the description so a client sees them.
  const at = (node: unknown, ...path: string[]): Json | undefined =>
    path.reduce<unknown>(
      (cur, key) => (cur as Json | undefined)?.[key],
      node,
    ) as Json | undefined;
  const currency = at(
    schemas.CreateProduct,
    'properties',
    'price',
    'properties',
    'currency',
  );
  if (currency)
    currency.description =
      'Only currencies the marketplace supports; any other code answers 400 `validation_failed` (field price.currency, code `unsupported`).';
  const delta = at(
    schemas.BulkStock,
    'properties',
    'items',
    'items',
    'properties',
    'delta',
  );
  if (delta) {
    delta.not = { const: 0 };
    delta.description = 'A change of 0 is refused (400 `validation_failed`).';
  }
  const oneOfVersions = (resource: 'Product' | 'Order'): Json => ({
    description: 'The shape depends on the Marketplace-Version of the request.',
    oneOf: versions
      .filter((v) => schemas[`${resource}_${versionKey(v)}`])
      .map((v) => ref(`${resource}_${versionKey(v)}`)),
  });
  schemas.Product = oneOfVersions('Product');
  schemas.Order = oneOfVersions('Order');
  const list = (item: 'Product' | 'Order'): Json => ({
    type: 'object',
    required: ['object', 'data', 'has_more', 'next_cursor'],
    properties: {
      object: { const: 'list' },
      data: { type: 'array', items: ref(item) },
      has_more: { type: 'boolean' },
      next_cursor: { type: ['string', 'null'] },
    },
  });
  schemas.ProductList = list('Product');
  schemas.OrderList = list('Order');

  const successSchema = (r: PublicRoute): Json | undefined => {
    const s = r.success;
    if (s.resource === 'product')
      return ref(s.list ? 'ProductList' : 'Product');
    if (s.resource === 'order') return ref(s.list ? 'OrderList' : 'Order');
    if (s.resource === 'stock') return ref('Stock');
    if (s.resource === 'batch') return ref('BatchResult');
    if (s.resource === 'bulk')
      return { oneOf: [ref('BulkStockResult'), ref('BulkStockAccepted')] };
    if (s.resource === 'bulkJob') return ref('BulkStockJob');
    return undefined;
  };

  const problemResponse = (status: number): Json => ({
    description: `Problem document (${[
      ...new Set(
        Object.entries(API_ERROR_CATALOGUE)
          .filter(([, [s]]) => s === status)
          .map(([code]) => code),
      ),
    ].join(', ')})`,
    headers: { 'Request-Id': { $ref: '#/components/headers/RequestId' } },
    content: { 'application/problem+json': { schema: ref('Problem') } },
  });

  const paths: Record<string, Record<string, Json>> = {};
  for (const r of PUBLIC_ROUTES) {
    const deprecation =
      DEPRECATED_ROUTES[`${r.method.toUpperCase()} ${r.template}`];
    const parameters: Json[] = [
      { $ref: '#/components/parameters/MarketplaceVersion' },
    ];
    for (const p of r.path.matchAll(/\{(\w+)\}/g))
      parameters.push({
        name: p[1],
        in: 'path',
        required: true,
        schema: { type: 'string' },
      });
    if (r.idempotencyKey)
      parameters.push({ $ref: '#/components/parameters/IdempotencyKey' });
    if (r.ifMatch) parameters.push({ $ref: '#/components/parameters/IfMatch' });
    if (r.success.list)
      parameters.push(
        { $ref: '#/components/parameters/Limit' },
        { $ref: '#/components/parameters/Cursor' },
        { $ref: '#/components/parameters/Fields' },
        { $ref: '#/components/parameters/Expand' },
      );
    else if (r.list)
      parameters.push(
        { $ref: '#/components/parameters/Fields' },
        { $ref: '#/components/parameters/Expand' },
      );
    const success = successSchema(r);
    const responses: Record<string, Json> = {
      [String(r.success.status)]: {
        description: 'Success',
        headers: {
          'Request-Id': { $ref: '#/components/headers/RequestId' },
          'Marketplace-Version': {
            $ref: '#/components/headers/MarketplaceVersion',
          },
          RateLimit: { $ref: '#/components/headers/RateLimit' },
          'RateLimit-Policy': { $ref: '#/components/headers/RateLimitPolicy' },
          ...(r.ifMatch || r.success.resource === 'product'
            ? { ETag: { schema: { type: 'string' } } }
            : {}),
        },
        ...(success
          ? { content: { 'application/json': { schema: success } } }
          : {}),
      },
    };
    for (const status of r.errors)
      responses[String(status)] = problemResponse(status);
    (paths[r.path] ??= {})[r.method] = {
      operationId: r.operationId,
      summary: r.summary,
      tags: [r.tag],
      security: [{ bearerAuth: r.scope ? [r.scope] : [] }],
      ...(r.scope ? { 'x-required-scope': r.scope } : {}),
      parameters,
      ...(r.request
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: ref(r.request) } },
            },
          }
        : {}),
      responses,
      ...(deprecation
        ? {
            deprecated: true,
            'x-deprecated-at': deprecation.deprecatedAt,
            'x-sunset': deprecation.sunset,
            'x-replacement': deprecation.replacement,
          }
        : {}),
    };
  }
  paths['/v1/openapi.json'] = {
    get: {
      operationId: 'openapi',
      summary: 'This description',
      tags: ['meta'],
      security: [],
      responses: { '200': { description: 'The OpenAPI 3.1 document' } },
    },
  };

  const dashboard: [string, string, string][] = [
    ['post', '/api/shops/{shopId}/developers/keys', 'Create an API key'],
    ['get', '/api/shops/{shopId}/developers/keys', 'List the shop’s API keys'],
    [
      'post',
      '/api/shops/{shopId}/developers/keys/{keyId}/rotate',
      'Rotate an API key',
    ],
    [
      'delete',
      '/api/shops/{shopId}/developers/keys/{keyId}',
      'Revoke an API key',
    ],
    [
      'get',
      '/api/shops/{shopId}/developers/api-version',
      'Read the pinned API version',
    ],
    ['put', '/api/shops/{shopId}/developers/api-version', 'Pin an API version'],
    ['get', '/api/shops/{shopId}/developers/logs', 'Search the request log'],
    ['get', '/api/shops/{shopId}/developers/usage', 'Usage report'],
  ];
  // The seller dashboard routes of the inventory, photos, orders and shop-setup areas (B-063): same session as the web app.
  const SHOP_STATUSES = [400, 401, 403, 404, 409, 429];
  const area: [string, string, string, number[], Json[]?][] = [
    ['get', '/api/shops/mine', 'The shops of the signed-in person', [401]],
    [
      'post',
      '/api/shops',
      'Open a shop (the caller becomes its OWNER)',
      [400, 401, 409, 422, 429],
    ],
    ['get', '/api/shops/{shopId}', 'Read a shop', SHOP_STATUSES],
    [
      'patch',
      '/api/shops/{shopId}',
      'Change a shop’s name or settings',
      SHOP_STATUSES,
    ],
    [
      'get',
      '/api/shops/{shopId}/products',
      'List the shop’s products with search, status and stock filters',
      SHOP_STATUSES,
    ],
    [
      'post',
      '/api/shops/{shopId}/products',
      'Create a product',
      [...SHOP_STATUSES, 422],
    ],
    [
      'get',
      '/api/shops/{shopId}/products/{productId}',
      'Read one product',
      SHOP_STATUSES,
    ],
    [
      'patch',
      '/api/shops/{shopId}/products/{productId}',
      'Change a product (If-Match carries its version)',
      [...SHOP_STATUSES, 412, 422, 428],
    ],
    [
      'post',
      '/api/shops/{shopId}/products/{productId}/archive',
      'Archive a product',
      SHOP_STATUSES,
    ],
    [
      'post',
      '/api/shops/{shopId}/products/{productId}/restore',
      'Restore an archived product',
      SHOP_STATUSES,
    ],
    [
      'get',
      '/api/shops/{shopId}/products/{productId}/gallery',
      'Read a product’s photo gallery',
      SHOP_STATUSES,
    ],
    [
      'put',
      '/api/shops/{shopId}/products/{productId}/gallery',
      'Replace a product’s photo gallery',
      [...SHOP_STATUSES, 422],
    ],
    [
      'post',
      '/api/shops/{shopId}/media/uploads',
      'Start a photo upload (signed address)',
      [...SHOP_STATUSES, 413, 415, 422],
    ],
    [
      'get',
      '/api/shops/{shopId}/orders',
      'List the shop’s order slices, newest first (no buyer identity)',
      SHOP_STATUSES,
      [
        {
          name: 'status',
          in: 'query',
          schema: {
            type: 'string',
            enum: ['PENDING', 'PAID', 'CANCELLED', 'REFUNDED'],
          },
        },
        {
          name: 'limit',
          in: 'query',
          schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        },
        {
          name: 'cursor',
          in: 'query',
          description: 'Opaque cursor from `nextCursor`; bound to the shop.',
          schema: { type: 'string' },
        },
      ],
    ],
  ];
  for (const [method, path, summary, statuses, extra] of area)
    (paths[path] ??= {})[method] = {
      operationId: `seller_${method}_${path.replace(/[^a-z]+/gi, '_')}`,
      summary,
      tags: ['seller'],
      security: [{ sessionAuth: [] }],
      parameters: [
        ...[...path.matchAll(/\{(\w+)\}/g)].map((p) => ({
          name: p[1],
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        })),
        ...(extra ?? []),
      ],
      responses: {
        [method === 'post' &&
        !path.endsWith('/archive') &&
        !path.endsWith('/restore')
          ? '201'
          : '200']: { description: 'Success' },
        ...Object.fromEntries(
          statuses.map((status) => [String(status), problemResponse(status)]),
        ),
      },
    };
  for (const [method, path, summary] of dashboard)
    (paths[path] ??= {})[method] = {
      operationId: `dashboard_${method}_${path.replace(/[^a-z]+/gi, '_')}`,
      summary,
      tags: ['dashboard'],
      security: [{ sessionAuth: [] }],
      parameters: [...path.matchAll(/\{(\w+)\}/g)].map((p) => ({
        name: p[1],
        in: 'path',
        required: true,
        schema: { type: 'string' },
      })),
      responses: {
        '200': { description: 'Success' },
        '401': problemResponse(401),
        '403': problemResponse(403),
      },
    };
  paths['/api/developers/openapi.json'] = {
    get: {
      operationId: 'dashboardOpenapi',
      summary: 'This description (same origin)',
      tags: ['meta'],
      security: [],
      responses: { '200': { description: 'The OpenAPI 3.1 document' } },
    },
  };

  return {
    openapi: '3.1.0',
    info: {
      title: 'Marketplace seller API',
      version: latestVersion(),
      description:
        'Server-to-server API for sellers. Money is an object {amount, currency} in minor units from version 2026-10-01. ' +
        'Errors are application/problem+json with a stable `code`; the codes are listed in the Problem schema.',
    },
    servers: [{ url: '/' }],
    tags: [
      { name: 'products' },
      { name: 'stock' },
      { name: 'orders' },
      { name: 'batch' },
      { name: 'dashboard' },
      { name: 'seller' },
      { name: 'meta' },
    ],
    'x-versions': VERSION_REGISTRY.map((v) => ({
      version: v.version,
      status: v.lifecycle.status,
      ...(v.lifecycle.status === 'deprecated'
        ? { deprecatedAt: v.lifecycle.deprecatedAt, sunset: v.lifecycle.sunset }
        : {}),
    })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'sk_live_… / sk_test_… (scope names in the operation)',
        },
        sessionAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      headers: {
        RequestId: {
          description: 'Unique, server-generated id of the request',
          schema: { type: 'string' },
        },
        MarketplaceVersion: {
          description: 'The version the response is shaped for',
          schema: { type: 'string' },
        },
        RateLimit: {
          description:
            'IETF structured field: remaining units and seconds to reset',
          schema: { type: 'string' },
        },
        RateLimitPolicy: {
          description: 'IETF structured field: quota and window',
          schema: { type: 'string' },
        },
      },
      parameters: {
        MarketplaceVersion: {
          name: 'Marketplace-Version',
          in: 'header',
          required: false,
          description:
            'A registered version date; overrides the shop’s pin for this request only. An unknown value answers 400 `invalid_version`.',
          schema: { type: 'string', enum: versions },
        },
        IdempotencyKey: {
          name: 'Idempotency-Key',
          in: 'header',
          required: true,
          description:
            '1 to 255 printable characters; scoped to the acting shop and route; kept 24 hours.',
          schema: { type: 'string', minLength: 1, maxLength: 255 },
        },
        IfMatch: {
          name: 'If-Match',
          in: 'header',
          required: true,
          description:
            'Required. The product version from its ETag, e.g. "7". Missing: 428 `precondition_required`; malformed: 400; stale: 412.',
          schema: { type: 'string' },
        },
        Limit: {
          name: 'limit',
          in: 'query',
          schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        },
        Cursor: {
          name: 'cursor',
          in: 'query',
          description: 'Opaque cursor from `next_cursor`.',
          schema: { type: 'string' },
        },
        Fields: {
          name: 'fields',
          in: 'query',
          description: 'Comma-separated field names of the requested version.',
          schema: { type: 'string' },
        },
        Expand: {
          name: 'expand',
          in: 'query',
          description:
            '`shop` only, at most 3 values; anything else answers 400 `invalid_expand`.',
          schema: { type: 'string', pattern: '^shop(,shop){0,2}$' },
        },
      },
      schemas: {
        ...schemas,
        Problem: {
          ...schemas.Problem,
          properties: {
            ...((schemas.Problem as { properties?: Json }).properties ?? {}),
            code: { type: 'string', enum: [...PUBLIC_API_ERROR_CODES] },
          },
        },
      },
    },
  };
}
