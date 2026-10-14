import type { ApiScope } from './api-key-format';

/** One route of the public API, as the OpenAPI description and the request records know it (contracts/http.md, section A). */
export interface PublicRoute {
  method: 'get' | 'post' | 'patch';
  /** OpenAPI path template: `/v1/products/{id}`. */
  path: string;
  /** The template the router and the request records use: `/v1/products/:id`. */
  template: string;
  operationId: string;
  summary: string;
  tag: 'products' | 'stock' | 'orders' | 'batch';
  /** `undefined`: no scope of its own (the batch answers per operation). */
  scope?: ApiScope;
  idempotencyKey?: 'required';
  ifMatch?: boolean;
  /** `list`: pagination, `fields`, `expand`. */
  list?: boolean;
  /** Component name of the request body. */
  request?: string;
  success: {
    status: number;
    resource?: 'product' | 'order' | 'stock' | 'batch' | 'bulk' | 'bulkJob';
    list?: boolean;
  };
  /** Statuses besides the success one this route can answer (problem documents). */
  errors: number[];
}

const COMMON = [401, 403, 429, 500, 503];

export const PUBLIC_ROUTES: PublicRoute[] = [
  {
    method: 'get',
    path: '/v1/products',
    template: '/v1/products',
    operationId: 'listProducts',
    tag: 'products',
    summary: 'List the shop’s products, newest first, with a keyset cursor',
    scope: 'products:read',
    list: true,
    success: { status: 200, resource: 'product', list: true },
    errors: [400, 406, ...COMMON],
  },
  {
    method: 'get',
    path: '/v1/products/{id}',
    template: '/v1/products/:id',
    operationId: 'getProduct',
    tag: 'products',
    summary: 'Read one product',
    scope: 'products:read',
    list: true,
    success: { status: 200, resource: 'product' },
    errors: [400, 404, 406, ...COMMON],
  },
  {
    method: 'post',
    path: '/v1/products',
    template: '/v1/products',
    operationId: 'createProduct',
    tag: 'products',
    summary: 'Create a product',
    scope: 'products:write',
    idempotencyKey: 'required',
    request: 'CreateProduct',
    success: { status: 201, resource: 'product' },
    errors: [400, 409, 413, 415, 422, ...COMMON],
  },
  {
    method: 'patch',
    path: '/v1/products/{id}',
    template: '/v1/products/:id',
    operationId: 'updateProduct',
    tag: 'products',
    summary: 'Change a product (optimistic concurrency with If-Match)',
    scope: 'products:write',
    ifMatch: true,
    request: 'UpdateProduct',
    success: { status: 200, resource: 'product' },
    errors: [400, 404, 409, 412, 413, 415, 428, ...COMMON],
  },
  {
    method: 'get',
    path: '/v1/stock/{productId}',
    template: '/v1/stock/:productId',
    operationId: 'getStock',
    tag: 'stock',
    summary: 'Read a product’s stock',
    scope: 'products:read',
    success: { status: 200, resource: 'stock' },
    errors: [404, ...COMMON],
  },
  {
    method: 'get',
    path: '/v1/products/{id}/stock',
    template: '/v1/products/:id/stock',
    operationId: 'getProductStock',
    tag: 'stock',
    summary: 'Read a product’s stock (deprecated)',
    scope: 'products:read',
    success: { status: 200, resource: 'stock' },
    errors: [404, 410, ...COMMON],
  },
  {
    method: 'post',
    path: '/v1/stock/bulk',
    template: '/v1/stock/bulk',
    operationId: 'bulkStock',
    tag: 'stock',
    summary:
      'Change stock by deltas with operation ids (up to 100 items at once, more as a job)',
    scope: 'stock:write',
    idempotencyKey: 'required',
    request: 'BulkStock',
    success: { status: 200, resource: 'bulk' },
    errors: [400, 413, 415, 422, ...COMMON],
  },
  {
    method: 'get',
    path: '/v1/stock/bulk/{jobId}',
    template: '/v1/stock/bulk/:jobId',
    operationId: 'getBulkStockJob',
    tag: 'stock',
    summary: 'Read a bulk stock job',
    scope: 'stock:write',
    success: { status: 200, resource: 'bulkJob' },
    errors: [404, ...COMMON],
  },
  {
    method: 'get',
    path: '/v1/orders',
    template: '/v1/orders',
    operationId: 'listOrders',
    tag: 'orders',
    summary: 'List the shop’s slices of orders, newest first',
    scope: 'orders:read',
    list: true,
    success: { status: 200, resource: 'order', list: true },
    errors: [400, 406, ...COMMON],
  },
  {
    method: 'get',
    path: '/v1/orders/{id}',
    template: '/v1/orders/:id',
    operationId: 'getOrder',
    tag: 'orders',
    summary: 'Read one order slice',
    scope: 'orders:read',
    success: { status: 200, resource: 'order' },
    errors: [404, 406, ...COMMON],
  },
  {
    method: 'post',
    path: '/v1/batch',
    template: '/v1/batch',
    operationId: 'batch',
    tag: 'batch',
    summary: 'Run up to 50 operations, each answering for itself',
    idempotencyKey: 'required',
    request: 'Batch',
    success: { status: 200, resource: 'batch' },
    errors: [400, 413, 415, 422, ...COMMON],
  },
];

const compiled = PUBLIC_ROUTES.map((r) => ({
  route: r,
  re: new RegExp(
    `^${r.template
      .split('/')
      .map((seg) => (seg.startsWith(':') ? '[^/]+' : seg))
      .join('/')}/?$`,
  ),
}));

/** The route template of a request path, or `null` when no public route has that shape (never a path with an id in it). */
export function routeTemplateOf(
  method: string,
  rawPath: string,
): string | null {
  const path = rawPath.split('?')[0];
  const verb = (
    method === 'HEAD' ? 'get' : method.toLowerCase()
  ) as PublicRoute['method'];
  return (
    compiled.find((c) => c.route.method === verb && c.re.test(path))?.route
      .template ?? null
  );
}
