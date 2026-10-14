import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from './index';
import { loaderScript } from './widget-loader';

/**
 * S44 AS-47…AS-49: the generated loader script, run against a hand-written DOM (a handful of fake elements, a fake
 * window and a fake `fetch`). It is the only place the `postMessage` filtering can be proven without a browser; the
 * real-browser journey (AS-50) belongs to W07.
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
		if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
		this.parentNode = null;
	}
	click() {
		for (const fn of this.listeners.click ?? []) fn();
	}
}

interface Config {
	[field: string]: unknown;
}

function product(over: Config = {}) {
	return { id: 'p-1', title: 'Earbuds', price: { amountMinor: 12900, currency: 'USD' }, inStock: true, ...over };
}

function config(over: Config = {}) {
	return { version: 'v1', shop: { name: 'My Shop' }, theme: {}, products: [product()], checkoutUrl: `${API}/embed/checkout`, ...over };
}

type Reply = { ok: boolean; status: number; body?: unknown; jsonThrows?: boolean } | 'network';

function mount(options: { key?: string | null; reply?: Reply; existing?: boolean } = {}) {
	const body = new FakeEl('body');
	const host = new FakeEl('div');
	body.appendChild(host);
	const scriptEl = new FakeEl('script');
	host.appendChild(scriptEl);
	if (options.key !== null) scriptEl.setAttribute('data-site-key', options.key ?? KEY);
	const handlers: ((event: { origin: string; source: unknown; data: unknown }) => void)[] = [];
	const win: Record<string, unknown> = {
		addEventListener: (type: string, fn: (event: never) => void) => {
			if (type === 'message') handlers.push(fn as never);
		},
	};
	if (options.existing) win.MarketplaceWidget = { version: 'other' };
	const fetchCalls: { url: string; init: unknown }[] = [];
	const reply: Reply = options.reply ?? { ok: true, status: 200, body: config() };
	const fakeFetch = (url: string, init: unknown) => {
		fetchCalls.push({ url, init });
		if (reply === 'network') return Promise.reject(new TypeError('network down'));
		return Promise.resolve({
			ok: reply.ok,
			status: reply.status,
			json: () => {
				// a body that is not JSON: `Response.json()` rejects; throwing inside the `then` callback is the same path for the loader
				if (reply.jsonThrows) throw new SyntaxError('bad json');
				return Promise.resolve(reply.body);
			},
		});
	};
	const doc = {
		currentScript: scriptEl,
		body,
		createElement: (tag: string) => new FakeEl(tag),
		querySelector: () => null,
	};
	const run = () => new Function('window', 'document', 'fetch', 'setTimeout', 'clearTimeout', loaderScript(API))(win, doc, fakeFetch, setTimeout, clearTimeout);
	return {
		host,
		body,
		win,
		fetchCalls,
		run,
		send: (event: { origin?: string; source?: unknown; data: unknown }) => {
			for (const h of handlers) h({ origin: event.origin ?? API, source: event.source, data: event.data });
		},
		buttons: () => host.children.filter((c) => c.tag === 'button'),
		frame: () => body.children.find((c) => c.tag === 'iframe'),
	};
}

const flush = async () => {
	for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe('S44 loader contract (AS-47)', () => {
	it('S44 AS-47: the script is at most 5,120 bytes and one self-invoking function', () => {
		const script = loaderScript(API);
		expect(new TextEncoder().encode(script).length).toBeLessThanOrEqual(5120);
		expect(script.trim().startsWith('(function')).toBe(true);
		expect(script.trim().endsWith('})();')).toBe(true);
	});

	it('S44 AS-47: it contains no unsafe sink, no wildcard target and no storage', () => {
		const script = loaderScript(API);
		for (const forbidden of [
			/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\b/, /new Function/, /setTimeout\(\s*['"`]/, /setInterval/,
			/postMessage\([^)]*['"]\*['"]/, /localStorage/, /sessionStorage/, /document\.cookie/, /location\./, /import\(/,
		])
			expect(script).not.toMatch(forbidden);
		expect(script).toContain("credentials: 'omit'");
	});

	it('S44 AS-47: it creates exactly one global, MarketplaceWidget, and does nothing when it already exists', () => {
		const page = mount();
		page.run();
		expect(Object.keys(page.win).sort()).toEqual(['MarketplaceWidget', 'addEventListener']);
		expect(page.win.MarketplaceWidget).toEqual({ version: 'v1', identify: null });

		const existing = mount({ existing: true });
		existing.run();
		expect(existing.fetchCalls).toHaveLength(0);
		expect(existing.win.MarketplaceWidget).toEqual({ version: 'other' });
	});

	it('S44 AS-47: it reads the key only from its own script tag and calls config without credentials', async () => {
		const page = mount({ key: 'pk_live_zzzzzzzzzzzzzzzzzzzzzzzz' });
		page.run();
		await flush();
		expect(page.fetchCalls).toHaveLength(1);
		expect(page.fetchCalls[0].url).toBe(`${API}/api/widget/v1/config?key=pk_live_zzzzzzzzzzzzzzzzzzzzzzzz`);
		expect(page.fetchCalls[0].init).toEqual({ credentials: 'omit' });
	});

	it('S44 AS-47: the key is encoded into the URL', async () => {
		const page = mount({ key: 'a b&c=d' });
		page.run();
		await flush();
		expect(page.fetchCalls[0].url).toBe(`${API}/api/widget/v1/config?key=a%20b%26c%3Dd`);
	});

	it('S44 AS-47: the worker serves it at /widget/v1/loader.js with the cache and sniffing headers', async () => {
		const env = { REALTIME_ORIGIN: API } as unknown as Env;
		const res = await worker.fetch(new Request('https://edge.example/widget/v1/loader.js'), env, { waitUntil() {} } as never);
		expect(res.status).toBe(200);
		expect(res.headers.get('Cache-Control')).toBe('public, max-age=300, s-maxage=300');
		expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
		expect(res.headers.get('Content-Type')).toMatch(/javascript/);
		expect(await res.text()).toBe(loaderScript(API));
	});
});

describe('S44 postMessage contract (AS-48)', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const open = async (page: ReturnType<typeof mount>) => {
		page.run();
		await vi.advanceTimersByTimeAsync(0);
		page.buttons()[0].click();
		return page.frame()!;
	};

	it('S44 AS-48: clicking a button opens the iframe with the embed address, referrer policy and loading mode', async () => {
		const page = mount();
		const frame = await open(page);
		expect(frame.attrs.src).toBe(`${API}/api/widget/v1/embed?key=${KEY}#product=p-1`);
		expect(frame.attrs.referrerpolicy).toBe('strict-origin-when-cross-origin');
		expect(frame.attrs.loading).toBe('eager');
		expect(frame.attrs.allow).toBe('payment');
	});

	it('S44 AS-48: messages from a foreign origin, another window, with an unknown type, a bad body or extra fields are ignored', async () => {
		const page = mount();
		const frame = await open(page);
		const ignored: { origin?: string; source?: unknown; data: unknown }[] = [
			{ origin: 'https://evil.example', source: frame.contentWindow, data: { type: 'marketplace:close' } },
			{ source: new FakeFrameWindow(), data: { type: 'marketplace:close' } },
			{ source: undefined, data: { type: 'marketplace:close' } },
			{ source: frame.contentWindow, data: { type: 'marketplace:unknown' } },
			{ source: frame.contentWindow, data: 'marketplace:close' },
			{ source: frame.contentWindow, data: null },
			{ source: frame.contentWindow, data: 42 },
			{ source: frame.contentWindow, data: ['marketplace:close'] },
			{ source: frame.contentWindow, data: { type: 'marketplace:close', extra: 1 } },
			{ source: frame.contentWindow, data: { type: 'marketplace:need-identity', extra: 1 } },
			{ source: frame.contentWindow, data: { type: 'marketplace:identity', token: 'x' } },
		];
		for (const message of ignored) page.send(message);
		expect(page.frame()).toBe(frame);
		expect(frame.contentWindow.posted).toEqual([]);
	});

	it('S44 AS-48: marketplace:close from the iframe removes it, and a later message is ignored', async () => {
		const page = mount();
		const frame = await open(page);
		page.send({ source: frame.contentWindow, data: { type: 'marketplace:close' } });
		expect(page.frame()).toBeUndefined();
		expect(() => page.send({ source: frame.contentWindow, data: { type: 'marketplace:close' } })).not.toThrow();
		expect(frame.contentWindow.posted).toEqual([]);
	});

	it('S44 AS-48: need-identity awaits the host hook and posts the token to the iframe, with the explicit target origin', async () => {
		const page = mount();
		const frame = await open(page);
		(page.win.MarketplaceWidget as { identify: unknown }).identify = () => Promise.resolve('hand-off-token');
		page.send({ source: frame.contentWindow, data: { type: 'marketplace:need-identity' } });
		await vi.advanceTimersByTimeAsync(0);
		expect(frame.contentWindow.posted).toEqual([
			{ message: { type: 'marketplace:identity', token: 'hand-off-token' }, target: API },
		]);
		expect(frame.attrs.src).not.toContain('hand-off-token');
	});

	it('S44 AS-48: without a host hook nothing is posted; a hook that never answers is abandoned after 5 seconds', async () => {
		const none = mount();
		const f1 = await open(none);
		none.send({ source: f1.contentWindow, data: { type: 'marketplace:need-identity' } });
		await vi.advanceTimersByTimeAsync(10_000);
		expect(f1.contentWindow.posted).toEqual([]);

		const slow = mount();
		const f2 = await open(slow);
		(slow.win.MarketplaceWidget as { identify: unknown }).identify = () => new Promise(() => {});
		slow.send({ source: f2.contentWindow, data: { type: 'marketplace:need-identity' } });
		await vi.advanceTimersByTimeAsync(4_999);
		expect(f2.contentWindow.posted).toEqual([]);
		await vi.advanceTimersByTimeAsync(2);
		expect(f2.contentWindow.posted).toEqual([
			{ message: { type: 'marketplace:identity', token: null }, target: API },
		]);
	});

	it('S44 AS-48: the global exists before the key check, so a page without a key can still set its hook', () => {
		const page = mount({ key: null });
		page.run();
		expect(page.win.MarketplaceWidget).toEqual({ version: 'v1', identify: null });
		expect(() => {
			(page.win.MarketplaceWidget as { identify: unknown }).identify = () => Promise.resolve('x');
		}).not.toThrow();
		expect(page.fetchCalls).toHaveLength(0);
	});
});

describe('S44 failure isolation (AS-49)', () => {
	const drawn = async (page: ReturnType<typeof mount>) => {
		page.run();
		await flush();
		await flush();
		return page.buttons();
	};

	it.each([
		['a network failure', 'network' as Reply],
		['403', { ok: false, status: 403 } as Reply],
		['404', { ok: false, status: 404 } as Reply],
		['410', { ok: false, status: 410 } as Reply],
		['503', { ok: false, status: 503 } as Reply],
		['invalid JSON', { ok: true, status: 200, jsonThrows: true } as Reply],
		['a null body', { ok: true, status: 200, body: null } as Reply],
		['products that are not an array', { ok: true, status: 200, body: config({ products: 'nope' }) } as Reply],
		['a title that is not text', { ok: true, status: 200, body: config({ products: [product({ title: { toString: 1 } })] }) } as Reply],
		['an id that is not text', { ok: true, status: 200, body: config({ products: [product({ id: 7 })] }) } as Reply],
		['inStock that is not a boolean', { ok: true, status: 200, body: config({ products: [product({ inStock: 'yes' })] }) } as Reply],
		['a null product', { ok: true, status: 200, body: config({ products: [null] }) } as Reply],
		['13 products', { ok: true, status: 200, body: config({ products: Array.from({ length: 13 }, (_, i) => product({ id: `p-${i}` })) }) } as Reply],
	])('S44 AS-49: %s draws nothing and throws nothing', async (_name, reply) => {
		const page = mount({ reply });
		expect(await drawn(page)).toHaveLength(0);
		expect(page.frame()).toBeUndefined();
	});

	it('S44 AS-49: a page without a data-site-key draws nothing and calls nothing', async () => {
		const page = mount({ key: null });
		expect(await drawn(page)).toHaveLength(0);
		expect(page.fetchCalls).toHaveLength(0);
	});

	it('S44 AS-49: 12 products are drawn as text; an out-of-stock button is disabled and opens nothing', async () => {
		const products = Array.from({ length: 12 }, (_, i) => product({ id: `p-${i}`, title: `<b>Item ${i}</b>`, inStock: i !== 0 }));
		const page = mount({ reply: { ok: true, status: 200, body: config({ products }) } });
		const buttons = await drawn(page);
		expect(buttons).toHaveLength(12);
		expect(buttons[1].textContent).toBe('Buy <b>Item 1</b> on Marketplace');
		expect(buttons[0].attrs.disabled).toBe('disabled');
		buttons[0].click();
		expect(page.frame()).toBeUndefined();
		buttons[1].click();
		expect(page.frame()).toBeDefined();
	});

	it('S44 AS-49: a valid theme is applied as inline style values, anything else is ignored', async () => {
		const theme = { primaryColor: '#112233', textColor: '#ffffff', borderRadius: '8px', fontFamily: 'serif', buttonLabel: 'Buy now' };
		const good = mount({ reply: { ok: true, status: 200, body: config({ theme }) } });
		const [button] = await drawn(good);
		expect(button.textContent).toBe('Buy now');
		const style = button.attrs.style;
		expect(style).toContain('#112233');
		expect(style).toContain('#ffffff');
		expect(style).toContain('8px');
		expect(style).toMatch(/Georgia/);

		const hostile = {
			primaryColor: 'url(javascript:alert(1))', textColor: 'red', borderRadius: '25px', fontFamily: 'Comic Sans',
			buttonLabel: '<img src=x onerror=alert(1)>', backgroundColor: ['#aabbcc'], unknown: 'x',
		};
		const bad = mount({ reply: { ok: true, status: 200, body: config({ theme: hostile }) } });
		const [plain] = await drawn(bad);
		expect(plain.textContent).toBe('Buy Earbuds on Marketplace');
		expect(plain.attrs.style ?? '').not.toMatch(/javascript|red|25px|Comic|aabbcc|onerror|unknown/);
	});

	it('S44 AS-49: an identify hook that rejects or throws lets the iframe go on without a customer', async () => {
		vi.useFakeTimers();
		try {
			for (const hook of [() => Promise.reject(new Error('no')), () => { throw new Error('sync'); }]) {
				const page = mount();
				page.run();
				await vi.advanceTimersByTimeAsync(0);
				page.buttons()[0].click();
				const frame = page.frame()!;
				(page.win.MarketplaceWidget as { identify: unknown }).identify = hook;
				expect(() => page.send({ source: frame.contentWindow, data: { type: 'marketplace:need-identity' } })).not.toThrow();
				await vi.advanceTimersByTimeAsync(0);
				expect(frame.contentWindow.posted).toEqual([
					{ message: { type: 'marketplace:identity', token: null }, target: API },
				]);
			}
		} finally {
			vi.useRealTimers();
		}
	});
});
