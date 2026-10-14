import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { server } from '../../../vitest.setup';
import { Reference } from './reference';

const doc = {
  openapi: '3.1.0',
  info: { title: 'Marketplace seller API', version: '2026-10-01', description: 'Server-to-server API.' },
  tags: [{ name: 'products', description: 'Your **catalogue**.' }, { name: 'stock' }],
  paths: {
    '/v1/products': {
      get: {
        operationId: 'listProducts',
        summary: 'List the products',
        description: 'Newest first. <script>window.__pwned = 1</script> See [the guide](https://example.com/guide) and [bad](javascript:alert(1)).',
        tags: ['products'],
        'x-required-scope': 'products:read',
        security: [{ bearerAuth: ['products:read'] }],
        parameters: [{ $ref: '#/components/parameters/Limit' }],
        responses: {
          '200': { description: 'Success', content: { 'application/json': { schema: { $ref: '#/components/schemas/ProductList' } } } },
          '429': { description: 'Problem document (rate_limited)' },
        },
      },
      post: {
        operationId: 'createProduct',
        summary: 'Create a product',
        tags: ['products'],
        'x-required-scope': 'products:write',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateProduct' } } } },
        responses: { '201': { description: 'Created' } },
      },
    },
    '/v1/stock/{productId}': {
      put: {
        operationId: 'setStock',
        summary: 'Set the stock of one product',
        tags: ['stock'],
        deprecated: true,
        'x-sunset': '2027-04-01T00:00:00Z',
        'x-replacement': '/v1/stock/bulk',
        'x-required-scope': 'stock:write',
        responses: { '200': { description: 'Success' } },
      },
    },
  },
  components: {
    parameters: { Limit: { name: 'limit', in: 'query', required: false, description: 'Page size', schema: { type: 'integer', minimum: 1, maximum: 100 } } },
    schemas: {
      ProductList: { type: 'object', required: ['items'], properties: { items: { type: 'array', items: { $ref: '#/components/schemas/CreateProduct' } }, nextCursor: { type: 'string' } } },
      CreateProduct: { type: 'object', required: ['title'], properties: { title: { type: 'string' }, price: { type: 'integer' } } },
    },
  },
};

function renderReference() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Reference />
    </QueryClientProvider>,
  );
}

const serve = (body: unknown = doc, init?: ResponseInit) => server.use(http.get('*/api/developers/openapi.json', () => HttpResponse.json(body as never, init)));

describe('W07 developer docs reference: content (AS-27)', () => {
  it('W07 AS-27: operations are grouped by tag, each group an h3 with its operations, scope and method/path shown', async () => {
    serve();
    renderReference();
    const productsGroup = await screen.findByRole('heading', { level: 3, name: 'products' });
    expect(productsGroup).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'stock' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /GET\s*\/v1\/products.*List the products/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /POST\s*\/v1\/products.*Create a product/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /PUT\s*\/v1\/stock\/\{productId\}/ })).toBeInTheDocument();
  });

  it('W07 AS-27: an expanded operation shows parameters, request and response shapes, response codes and the required scope', async () => {
    serve();
    const user = userEvent.setup();
    renderReference();
    await user.click(await screen.findByRole('button', { name: /GET\s*\/v1\/products/ }));
    const panel = screen.getByRole('region', { name: /GET\s*\/v1\/products/ });
    expect(within(panel).getByText('products:read')).toBeInTheDocument();
    expect(within(panel).getByText('limit')).toBeInTheDocument();
    expect(within(panel).getByText(/Page size/)).toBeInTheDocument();
    expect(within(panel).getByText('200')).toBeInTheDocument();
    expect(within(panel).getByText('429')).toBeInTheDocument();
    expect(within(panel).getByText(/nextCursor/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /POST\s*\/v1\/products/ }));
    const post = screen.getByRole('region', { name: /POST\s*\/v1\/products/ });
    expect(within(post).getByText(/title/)).toBeInTheDocument();
    expect(within(post).getByText('products:write')).toBeInTheDocument();
  });

  it('W07 AS-27: a deprecated operation says so, with its sunset date and its replacement', async () => {
    serve();
    const user = userEvent.setup();
    renderReference();
    await user.click(await screen.findByRole('button', { name: /PUT\s*\/v1\/stock\/\{productId\}/ }));
    const panel = screen.getByRole('region', { name: /PUT\s*\/v1\/stock/ });
    expect(within(panel).getByText(/Deprecated/)).toBeInTheDocument();
    expect(within(panel).getByText(/2027-04-01/)).toBeInTheDocument();
    expect(within(panel).getByText('/v1/stock/bulk')).toBeInTheDocument();
    expect(screen.getAllByText(/Deprecated/).length).toBeGreaterThan(0);
  });

  it('W07 AS-30: expanders are buttons with aria-expanded that open and close their region; the "Operations" navigation is labelled and lists the groups', async () => {
    serve();
    const user = userEvent.setup();
    renderReference();
    const expander = await screen.findByRole('button', { name: /GET\s*\/v1\/products/ });
    expect(expander).toHaveAttribute('aria-expanded', 'false');
    await user.click(expander);
    expect(expander).toHaveAttribute('aria-expanded', 'true');
    await user.click(expander);
    expect(expander).toHaveAttribute('aria-expanded', 'false');
    await user.keyboard('{Tab}');
    const nav = screen.getByRole('navigation', { name: 'Operations' });
    expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual(['products', 'stock']);
    expect(within(nav).getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(['#operations-products', '#operations-stock']);
  });

  it('W07 AS-27: headings nest without gaps below the page h1 and the reference adds no h1, banner or main', async () => {
    serve();
    const user = userEvent.setup();
    const { container } = renderReference();
    await screen.findByRole('heading', { level: 3, name: 'products' });
    await user.click(screen.getByRole('button', { name: /GET\s*\/v1\/products/ }));
    expect(screen.queryAllByRole('heading', { level: 1 })).toHaveLength(0);
    expect(container.querySelector('main, header')).toBeNull();
    let previous = 1;
    for (const heading of screen.getAllByRole('heading')) {
      const level = Number(heading.tagName.slice(1));
      expect(level, heading.textContent ?? '').toBeLessThanOrEqual(previous + 1);
      previous = level;
    }
  });

  it('W07 FR-025: markdown is text: raw HTML is not rendered, javascript: links are not links, https links are', async () => {
    serve();
    const user = userEvent.setup();
    const { container } = renderReference();
    await user.click(await screen.findByRole('button', { name: /GET\s*\/v1\/products/ }));
    expect(container.querySelector('script')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    const guide = screen.getByRole('link', { name: /^the guide/ });
    expect(guide).toHaveAccessibleName('the guide (opens in a new tab)');
    expect(guide).toHaveAttribute('href', 'https://example.com/guide');
    expect(guide).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(screen.queryByRole('link', { name: 'bad' })).toBeNull();
    for (const anchor of container.querySelectorAll('a')) expect(anchor.getAttribute('href') ?? '').not.toMatch(/^javascript:/i);
  });
});

describe('W07 developer docs reference: states (AS-28)', () => {
  it('W07 AS-28: while the description loads the area is a placeholder marked aria-busy, then it is replaced by the reference', async () => {
    server.use(
      http.get('*/api/developers/openapi.json', async () => {
        await delay(150);
        return HttpResponse.json(doc);
      }),
    );
    renderReference();
    const busy = document.querySelector('[aria-busy="true"]');
    expect(busy).not.toBeNull();
    expect(screen.queryByRole('heading', { level: 3, name: 'products' })).toBeNull();
    await screen.findByRole('heading', { level: 3, name: 'products' });
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it('W07 AS-28: a 503 shows the unavailable text, the reference line only when there is a requestId, and Try again fetches and replaces in place', async () => {
    let calls = 0;
    server.use(
      http.get('*/api/developers/openapi.json', () => {
        calls += 1;
        if (calls === 1) return HttpResponse.json({ status: 503, code: 'service_unavailable', requestId: 'req-42' }, { status: 503, headers: { 'content-type': 'application/problem+json' } });
        return HttpResponse.json(doc);
      }),
    );
    const user = userEvent.setup();
    renderReference();
    expect(await screen.findByText('The API reference is temporarily unavailable.')).toBeInTheDocument();
    expect(screen.getByText(/req-42/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 3, name: 'products' })).toBeInTheDocument();
    expect(screen.queryByText('The API reference is temporarily unavailable.')).toBeNull();
    expect(calls).toBe(2);
  });

  it('W07 AS-28: a network failure and an invalid body both show the unavailable state, without a reference line', async () => {
    server.use(http.get('*/api/developers/openapi.json', () => HttpResponse.error()));
    const first = renderReference();
    expect(await screen.findByText('The API reference is temporarily unavailable.')).toBeInTheDocument();
    expect(screen.queryByText(/Reference:/)).toBeNull();
    first.unmount();

    serve({ openapi: '2.0', info: { title: 'x' }, paths: {} });
    renderReference();
    expect(await screen.findByText('The API reference is temporarily unavailable.')).toBeInTheDocument();
    expect(screen.queryByText(/Reference:/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('W07 developer docs reference: read-only (AS-29)', () => {
  it('W07 AS-29: no "Try it out", no form, no input that sends a request; exactly one data request', async () => {
    let calls = 0;
    server.use(
      http.get('*/api/developers/openapi.json', () => {
        calls += 1;
        return HttpResponse.json(doc);
      }),
    );
    const user = userEvent.setup();
    const { container } = renderReference();
    await user.click(await screen.findByRole('button', { name: /POST\s*\/v1\/products/ }));
    expect(screen.queryByText(/try it out/i)).toBeNull();
    expect(container.querySelector('form, input, textarea, select')).toBeNull();
    expect(calls).toBe(1);
  });

  it('W07 AS-29: Copy puts the example on the clipboard and announces "Copied"', async () => {
    serve();
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    renderReference();
    await user.click(await screen.findByRole('button', { name: /GET\s*\/v1\/products/ }));
    const copy = screen.getAllByRole('button', { name: /^Copy/ })[0];
    await user.click(copy);
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    expect(String(write.mock.calls[0][0])).toContain('/v1/products');
    expect(String(write.mock.calls[0][0])).not.toMatch(/https?:\/\/(localhost|127\.)/);
    expect(await screen.findByText('Copied')).toBeInTheDocument();
    expect(screen.getByText('Copied').closest('[role="status"]')).not.toBeNull();
  });
});
