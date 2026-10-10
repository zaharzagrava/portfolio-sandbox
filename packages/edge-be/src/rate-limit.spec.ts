import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT, exportSPKI, generateKeyPair } from 'jose';
import worker, { SLIDING_WINDOW_LUA, edgeRateLimitStats, type Env } from './index';

/**
 * S50 US12: the edge limiter. The worker's `fetch` handler runs against a fake edge store that answers the worker's
 * single EVAL call. The fake evaluates the script's contract in JavaScript (the Lua runs only in the real store), so
 * what is proven here is the worker's side: one atomic call per decision, the keys and arguments it sends, the
 * `429` it builds from the answer, the fail-open path and the subject it picks.
 */

const STORE = 'https://edge-store.test/';
const ORIGIN = 'https://realtime.test';
const WINDOW_MS = 60_000;
const LIMIT = 120;
const BOUNDARY = Math.floor(1_900_000_000_000 / WINDOW_MS) * WINDOW_MS; // an aligned window start

type StoreMode = 'ok' | 'down' | 'slow' | 'malformed';

class FakeEdgeStore {
	readonly counters = new Map<string, number>();
	readonly commands: unknown[][] = [];
	mode: StoreMode = 'ok';

	/** Mirror of SLIDING_WINDOW_LUA: integer arithmetic on window-scaled counts. */
	private eval(keys: string[], args: string[]): [number, number, number] {
		const [limit, W, elapsed] = args.map(Number);
		const current = this.counters.get(keys[0]) ?? 0;
		const previous = this.counters.get(keys[1]) ?? 0;
		const used = previous * (W - elapsed) + current * W;
		if (used + W <= limit * W) {
			this.counters.set(keys[0], current + 1);
			return [1, Math.floor((limit * W - used - W) / W), W - elapsed];
		}
		const room = (limit - current - 1) * W;
		let retry: number;
		if (room >= 0) retry = W - Math.floor(room / previous) - elapsed;
		else {
			let e3 = 0;
			if (current > 0) e3 = Math.max(0, W - Math.floor(((limit - 1) * W) / current));
			retry = W - elapsed + e3;
		}
		return [0, 0, Math.max(1, retry)];
	}

	async handle(init: RequestInit): Promise<Response> {
		const command = JSON.parse(String(init.body)) as unknown[];
		this.commands.push(command);
		if (this.mode === 'slow')
			await new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
		if (this.mode === 'malformed') return Response.json({ result: 'OK' });
		if (command[0] !== 'EVAL' || command[1] !== SLIDING_WINDOW_LUA) return Response.json({ error: 'unexpected command' }, { status: 400 });
		const [, , , ...rest] = command as string[];
		return Response.json({ result: this.eval(rest.slice(0, 2), rest.slice(2)) });
	}
}

let store: FakeEdgeStore;
let env: Env;
let privateKey: CryptoKey;
let keys: Awaited<ReturnType<typeof generateKeyPair>> | undefined;
let upstreamCalls: string[];

const call = (path: string, headers: Record<string, string> = {}) =>
	worker.fetch(new Request(`https://edge.test${path}`, { headers }), env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);

const token = (sub: string) => new SignJWT({}).setProtectedHeader({ alg: 'RS256' }).setSubject(sub).setIssuedAt().setExpirationTime('1h').sign(privateKey);

const search = (headers?: Record<string, string>) => call('/api/products/search?q=shoes', headers);
const edgeKeys = () => store.commands.map((c) => (c as string[])[3]);

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(BOUNDARY + 10_000);
	store = new FakeEdgeStore();
	upstreamCalls = [];
	// one key pair for the whole file: the worker caches the imported key for the life of the isolate
	keys ??= await generateKeyPair('RS256', { extractable: true });
	privateKey = keys.privateKey;
	env = {
		UPSTASH_REDIS_REST_URL: STORE,
		UPSTASH_REDIS_REST_TOKEN: 'secret-token',
		KAFKA_BROKER: 'broker.test',
		JWT_PUBLIC_KEY: await exportSPKI(keys.publicKey),
		REALTIME_ORIGIN: ORIGIN,
	};
	edgeRateLimitStats.failOpen = 0;
	vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url === STORE) {
			if (store.mode === 'down') {
				store.commands.push(JSON.parse(String(init?.body)) as unknown[]);
				throw new TypeError('connection refused');
			}
			return store.handle(init ?? {});
		}
		if (url.startsWith(ORIGIN)) {
			upstreamCalls.push(url);
			return new Response('found', { status: 200 });
		}
		throw new Error(`unexpected fetch ${url}`);
	});
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('S50 edge rate limit', () => {
	it('S50 AS-76: at a window boundary at most limit + 2 requests pass in the second after it, with one atomic store call per decision', async () => {
		const headers = { 'CF-Connecting-IP': '203.0.113.7' };
		vi.setSystemTime(BOUNDARY - 1_000); // the last second of a window: a full burst is admitted
		let admittedBefore = 0;
		for (let i = 0; i < LIMIT; i++) if ((await search(headers)).status === 200) admittedBefore++;
		expect(admittedBefore).toBe(LIMIT);

		let admittedAfter = 0;
		for (let offset = 0; offset <= 1_000; offset += 100) {
			vi.setSystemTime(BOUNDARY + offset);
			for (let i = 0; i < 20; i++) if ((await search(headers)).status === 200) admittedAfter++;
		}
		expect(admittedAfter).toBeLessThanOrEqual(2);
		expect(admittedBefore + admittedAfter).toBeLessThanOrEqual(LIMIT + 2);

		// one store call per decision, each one EVAL; nothing else is ever sent
		expect(store.commands.length).toBe(LIMIT + 11 * 20);
		expect(store.commands.every((c) => c[0] === 'EVAL')).toBe(true);
	});

	it('S50 AS-76: the worker passes the limit, the window, the elapsed time and the two window keys of one hash tag', async () => {
		vi.setSystemTime(BOUNDARY + 12_345);
		await search({ 'CF-Connecting-IP': '203.0.113.7' });
		const [, , nKeys, k1, k2, limit, window, elapsed] = store.commands[0] as string[];
		expect(nKeys).toBe('2');
		expect(limit).toBe(String(LIMIT));
		expect(window).toBe(String(WINDOW_MS));
		expect(elapsed).toBe('12345');
		const tag = (k: string) => /\{[^}]*\}/.exec(k)?.[0];
		expect(tag(k1)).toBe(tag(k2));
		expect(k1.endsWith(`:${BOUNDARY / WINDOW_MS}`)).toBe(true);
		expect(k2.endsWith(`:${BOUNDARY / WINDOW_MS - 1}`)).toBe(true);
	});

	it('S50 AS-77: the 429 is problem+json with Retry-After and the RateLimit headers, and says nothing about the subject', async () => {
		const headers = { 'CF-Connecting-IP': '203.0.113.99' };
		for (let i = 0; i < LIMIT; i++) expect((await search(headers)).status).toBe(200);
		const res = await search(headers);
		expect(res.status).toBe(429);
		expect(res.headers.get('Content-Type')).toMatch(/application\/problem\+json/);
		const retry = Number(res.headers.get('Retry-After'));
		expect(Number.isInteger(retry)).toBe(true);
		expect(retry).toBeGreaterThanOrEqual(1);
		expect(res.headers.get('RateLimit-Policy')).toBe(`"edge";q=${LIMIT};w=60`);
		expect(res.headers.get('RateLimit')).toBe(`"edge";r=0;t=${retry}`);
		expect(res.headers.get('Cache-Control')).toBe('no-store');
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toMatchObject({ title: 'Too Many Requests', status: 429, code: 'rate_limited', retryAfterSeconds: retry });
		expect(typeof body.type).toBe('string');
		expect(typeof body.detail).toBe('string');
		expect(body.instance).toBe('/api/products/search');
		expect(JSON.stringify(body)).not.toContain('203.0.113.99');
		expect(upstreamCalls).toHaveLength(LIMIT); // the refused request never reached the origin
	});

	it.each<StoreMode>(['down', 'malformed'])('S50 AS-78: a %s store fails open: the request is served, counted and logged', async (mode) => {
		store.mode = mode;
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const res = await search({ 'CF-Connecting-IP': '203.0.113.7' });
		expect(res.status).toBe(200);
		expect(upstreamCalls).toHaveLength(1);
		expect(edgeRateLimitStats.failOpen).toBe(1);
		expect(warn.mock.calls.some((c) => String(c[0]).includes('edge_rate_limit_fail_open'))).toBe(true);
		expect(warn.mock.calls.map((c) => String(c[0])).join()).not.toContain('secret-token');
	});

	it('S50 AS-78: a store that does not answer is abandoned after 500 ms and the request is served', async () => {
		store.mode = 'slow';
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const started = performance.now();
		const res = await search({ 'CF-Connecting-IP': '203.0.113.7' });
		const elapsed = performance.now() - started;
		expect(res.status).toBe(200);
		expect(elapsed).toBeGreaterThanOrEqual(450);
		expect(elapsed).toBeLessThan(800);
		expect(edgeRateLimitStats.failOpen).toBe(1);
	});

	it('S50 AS-79: the subject is the verified user id, else the CDN address, else one shared name; forwarding headers are ignored', async () => {
		await search({ Authorization: `Bearer ${await token('user-42')}`, 'CF-Connecting-IP': '203.0.113.1' });
		await search({ 'CF-Connecting-IP': '203.0.113.2', 'X-Forwarded-For': '198.51.100.9', 'X-Real-IP': '198.51.100.8' });
		await search();
		await search({ Authorization: 'Bearer not-a-token', 'CF-Connecting-IP': '203.0.113.3' });
		const [verified, address, none, forged] = edgeKeys();
		expect(verified).toContain('{user:user-42}');
		expect(address).toContain('{ip:203.0.113.2}');
		expect(address).not.toContain('198.51.100');
		expect(none).toContain('{anonymous}');
		expect(forged).toContain('{ip:203.0.113.3}'); // an unverifiable token is not an identity
	});

	it('S50 AS-79: two users behind one address have separate budgets', async () => {
		const a = { Authorization: `Bearer ${await token('user-a')}`, 'CF-Connecting-IP': '203.0.113.1' };
		const b = { Authorization: `Bearer ${await token('user-b')}`, 'CF-Connecting-IP': '203.0.113.1' };
		for (let i = 0; i < LIMIT; i++) await search(a);
		expect((await search(a)).status).toBe(429);
		expect((await search(b)).status).toBe(200);
	});
});
