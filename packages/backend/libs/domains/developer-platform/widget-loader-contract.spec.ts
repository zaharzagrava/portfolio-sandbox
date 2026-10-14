import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { compileFunction } from 'vm';
import { loaderScript } from '../../../../edge-be/src/widget-loader';
import { OWNERSHIP } from '../../../db/ownership';

/**
 * S44 AS-47…AS-50 and AS-54 from the backend side: the generated loader script run against a hand-written DOM
 * (fake elements, window and `fetch`), and the static ownership rules of the capability. The loader's own unit
 * file (packages/edge-be/src/widget-loader.spec.ts) goes further on the worker headers; a real browser is W07's.
 */

const API = 'https://api.example';
const KEY = 'pk_live_abcdefghijklmnopqrstuvwx';

class FakeFrameWindow {
  readonly posted: { message: unknown; target: string }[] = [];
  postMessage(message: unknown, target: string) {
    this.posted.push({ message, target });
  }
}

class FakeEl {
  attrs: Record<string, string> = {};
  children: FakeEl[] = [];
  textContent = '';
  parentNode: FakeEl | null = null;
  listeners: Record<string, (() => void)[]> = {};
  contentWindow = new FakeFrameWindow();
  constructor(readonly tag: string) {}
  setAttribute(name: string, value: string) {
    this.attrs[name] = value;
  }
  getAttribute(name: string) {
    return name in this.attrs ? this.attrs[name] : null;
  }
  appendChild(child: FakeEl) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  addEventListener(type: string, fn: () => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  remove() {
    if (this.parentNode)
      this.parentNode.children = this.parentNode.children.filter(
        (c) => c !== this,
      );
    this.parentNode = null;
  }
  click() {
    for (const fn of this.listeners.click ?? []) fn();
  }
}

const product = (over: Record<string, unknown> = {}) => ({
  id: 'p-1',
  title: 'Earbuds',
  inStock: true,
  ...over,
});
const config = (over: Record<string, unknown> = {}) => ({
  version: 'v1',
  theme: {},
  products: [product()],
  ...over,
});

type Reply = { ok: boolean; status: number; body?: unknown } | 'network';

function mount(
  options: { key?: string | null; reply?: Reply; existing?: boolean } = {},
) {
  const body = new FakeEl('body');
  const host = new FakeEl('div');
  body.appendChild(host);
  const scriptEl = new FakeEl('script');
  host.appendChild(scriptEl);
  if (options.key !== null)
    scriptEl.setAttribute('data-site-key', options.key ?? KEY);
  const handlers: ((e: {
    origin: string;
    source: unknown;
    data: unknown;
  }) => void)[] = [];
  const win: Record<string, unknown> = {
    addEventListener: (type: string, fn: never) => {
      if (type === 'message') handlers.push(fn);
    },
  };
  if (options.existing) win.MarketplaceWidget = { version: 'other' };
  const fetchCalls: { url: string; init: unknown }[] = [];
  const reply: Reply = options.reply ?? {
    ok: true,
    status: 200,
    body: config(),
  };
  const fakeFetch = (url: string, init: unknown) => {
    fetchCalls.push({ url, init });
    if (reply === 'network')
      return Promise.reject(new TypeError('network down'));
    return Promise.resolve({
      ok: reply.ok,
      status: reply.status,
      json: () => Promise.resolve(reply.body),
    });
  };
  const doc = {
    currentScript: scriptEl,
    body,
    createElement: (tag: string) => new FakeEl(tag),
    querySelector: () => null,
  };
  const run = () =>
    compileFunction(loaderScript(API), [
      'window',
      'document',
      'fetch',
      'setTimeout',
      'clearTimeout',
    ])(win, doc, fakeFetch, setTimeout, clearTimeout);
  return {
    win,
    fetchCalls,
    run,
    send: (e: { origin?: string; source?: unknown; data: unknown }) => {
      for (const h of handlers)
        h({ origin: e.origin ?? API, source: e.source, data: e.data });
    },
    buttons: () => host.children.filter((c) => c.tag === 'button'),
    frame: () => body.children.find((c) => c.tag === 'iframe'),
  };
}

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe('S44 loader script (AS-47)', () => {
  it('S44 AS-47: at most 5,120 bytes, one self-invoking function, no unsafe sink, wildcard target or storage', () => {
    const script = loaderScript(API);
    expect(Buffer.byteLength(script)).toBeLessThanOrEqual(5120);
    expect(script.trim().startsWith('(function')).toBe(true);
    expect(script.trim().endsWith('})();')).toBe(true);
    for (const forbidden of [
      /innerHTML/,
      /outerHTML/,
      /insertAdjacentHTML/,
      /document\.write/,
      /\beval\b/,
      /new Function/,
      /setInterval/,
      /postMessage\([^)]*['"]\*['"]/,
      /localStorage/,
      /sessionStorage/,
      /document\.cookie/,
    ])
      expect(script).not.toMatch(forbidden);
    expect(script).toContain("credentials: 'omit'");
  });

  it('S44 AS-47: exactly one global, MarketplaceWidget, and nothing when it already exists', async () => {
    const page = mount();
    page.run();
    expect(Object.keys(page.win).sort()).toEqual([
      'MarketplaceWidget',
      'addEventListener',
    ]);
    expect(page.win.MarketplaceWidget).toEqual({
      version: 'v1',
      identify: null,
    });
    const existing = mount({ existing: true });
    existing.run();
    await flush();
    expect(existing.fetchCalls).toHaveLength(0);
  });

  it('S44 AS-47: the key comes from its own script tag, is URL-encoded, and config is called without credentials', async () => {
    const page = mount({ key: 'a b&c=d' });
    page.run();
    await flush();
    expect(page.fetchCalls).toHaveLength(1);
    expect(page.fetchCalls[0].url).toBe(
      `${API}/api/widget/v1/config?key=a%20b%26c%3Dd`,
    );
    expect(page.fetchCalls[0].init).toEqual({ credentials: 'omit' });
  });
});

describe('S44 postMessage filtering (AS-48)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const open = async (page: ReturnType<typeof mount>) => {
    page.run();
    await jest.advanceTimersByTimeAsync(0);
    page.buttons()[0].click();
    return page.frame()!;
  };

  it('S44 AS-48: foreign origin, other window, unknown type, bad body or extra fields are ignored', async () => {
    const page = mount();
    const frame = await open(page);
    expect(frame.attrs.src).toBe(
      `${API}/api/widget/v1/embed?key=${KEY}#product=p-1`,
    );
    expect(frame.attrs.referrerpolicy).toBe('strict-origin-when-cross-origin');
    const w = frame.contentWindow;
    const ignored = [
      {
        origin: 'https://evil.example',
        source: w,
        data: { type: 'marketplace:close' },
      },
      { source: new FakeFrameWindow(), data: { type: 'marketplace:close' } },
      { source: w, data: { type: 'marketplace:unknown' } },
      { source: w, data: 'marketplace:close' },
      { source: w, data: null },
      { source: w, data: ['marketplace:close'] },
      { source: w, data: { type: 'marketplace:close', extra: 1 } },
      { source: w, data: { type: 'marketplace:identity', token: 'x' } },
    ];
    for (const m of ignored) page.send(m);
    expect(page.frame()).toBe(frame);
    expect(w.posted).toEqual([]);
  });

  it('S44 AS-48: close removes the iframe; need-identity posts the host token to the explicit origin, or null after 5 seconds', async () => {
    const page = mount();
    const frame = await open(page);
    (page.win.MarketplaceWidget as { identify: unknown }).identify = () =>
      Promise.resolve('hand-off');
    page.send({
      source: frame.contentWindow,
      data: { type: 'marketplace:need-identity' },
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(frame.contentWindow.posted).toEqual([
      {
        message: { type: 'marketplace:identity', token: 'hand-off' },
        target: API,
      },
    ]);
    page.send({
      source: frame.contentWindow,
      data: { type: 'marketplace:close' },
    });
    expect(page.frame()).toBeUndefined();

    const slow = mount();
    const f2 = await open(slow);
    (slow.win.MarketplaceWidget as { identify: unknown }).identify = () =>
      new Promise(() => {});
    slow.send({
      source: f2.contentWindow,
      data: { type: 'marketplace:need-identity' },
    });
    await jest.advanceTimersByTimeAsync(4_999);
    expect(f2.contentWindow.posted).toEqual([]);
    await jest.advanceTimersByTimeAsync(2);
    expect(f2.contentWindow.posted).toEqual([
      { message: { type: 'marketplace:identity', token: null }, target: API },
    ]);
  });
});

describe('S44 loader failure isolation (AS-49)', () => {
  const drawn = async (page: ReturnType<typeof mount>) => {
    page.run();
    await flush();
    await flush();
    return page.buttons();
  };

  it.each([
    ['a network failure', 'network' as Reply],
    ['a 410', { ok: false, status: 410 } as Reply],
    ['a 503', { ok: false, status: 503 } as Reply],
    ['a null body', { ok: true, status: 200, body: null } as Reply],
    [
      'products that are not an array',
      { ok: true, status: 200, body: config({ products: 'nope' }) } as Reply,
    ],
    [
      'an id that is not text',
      {
        ok: true,
        status: 200,
        body: config({ products: [product({ id: 7 })] }),
      } as Reply,
    ],
    [
      '13 products',
      {
        ok: true,
        status: 200,
        body: config({
          products: Array.from({ length: 13 }, (_, i) =>
            product({ id: `p-${i}` }),
          ),
        }),
      } as Reply,
    ],
  ])('S44 AS-49: %s draws nothing and throws nothing', async (_name, reply) => {
    const page = mount({ reply });
    expect(await drawn(page)).toHaveLength(0);
    expect(page.frame()).toBeUndefined();
  });

  it('S44 AS-49: no data-site-key draws nothing; products are text, out-of-stock is disabled, a hostile theme is ignored', async () => {
    const none = mount({ key: null });
    expect(await drawn(none)).toHaveLength(0);
    expect(none.fetchCalls).toHaveLength(0);

    const products = [
      product({ id: 'p-0', title: '<b>Item</b>', inStock: false }),
      product({ id: 'p-1', title: '<b>Item</b>' }),
    ];
    const hostile = {
      primaryColor: 'url(javascript:alert(1))',
      borderRadius: '25px',
      fontFamily: 'Comic Sans',
      buttonLabel: '<img onerror=x>',
    };
    const page = mount({
      reply: {
        ok: true,
        status: 200,
        body: config({ products, theme: hostile }),
      },
    });
    const buttons = await drawn(page);
    expect(buttons).toHaveLength(2);
    expect(buttons[1].textContent).toBe('Buy <b>Item</b> on Marketplace');
    expect(buttons[0].attrs.disabled).toBe('disabled');
    expect(buttons[1].attrs.style ?? '').not.toMatch(
      /javascript|25px|Comic|onerror/,
    );
    buttons[0].click();
    expect(page.frame()).toBeUndefined();
  });
});

describe('S44 loader journey (AS-50)', () => {
  it("S44 AS-50: button, iframe over the page, hand-off token on request, close removes it (fake DOM; the browser run is W07's)", async () => {
    jest.useFakeTimers();
    try {
      const page = mount();
      page.run();
      await jest.advanceTimersByTimeAsync(0);
      expect(page.buttons()).toHaveLength(1);
      page.buttons()[0].click();
      const frame = page.frame()!;
      expect(frame.attrs.src).toContain('/api/widget/v1/embed?key=');
      (page.win.MarketplaceWidget as { identify: unknown }).identify =
        async () => 'host-token';
      page.send({
        source: frame.contentWindow,
        data: { type: 'marketplace:need-identity' },
      });
      await jest.advanceTimersByTimeAsync(0);
      expect(frame.contentWindow.posted[0]).toEqual({
        message: { type: 'marketplace:identity', token: 'host-token' },
        target: API,
      });
      page.send({
        source: frame.contentWindow,
        data: { type: 'marketplace:close' },
      });
      expect(page.frame()).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('S44 static ownership rules (AS-54)', () => {
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? sources(join(dir, e.name))
        : /widget/i.test(e.name) &&
            e.name.endsWith('.ts') &&
            !/spec\.ts$/.test(e.name)
          ? [join(dir, e.name)]
          : [],
    );

  it('S44 AS-54: WidgetSite and WidgetSiteChange are registered under domain:developer-platform', () => {
    expect(OWNERSHIP.WidgetSite).toBe('domain:developer-platform');
    expect(OWNERSHIP.WidgetSiteChange).toBe('domain:developer-platform');
  });

  it('S44 AS-54: widget code injects no foreign model and runs no raw SQL on Shop or Product', () => {
    const files = sources(__dirname);
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      expect({
        f,
        hit: /\b(ShopModel|ProductModel|ShopMembershipModel)\b/.test(text),
      }).toEqual({
        f,
        hit: false,
      });
      expect({
        f,
        hit: /(FROM|JOIN|UPDATE|INTO)\s+"(Shop|Product)"/i.test(text),
      }).toEqual({
        f,
        hit: false,
      });
    }
  });
});
