import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { setEdgeClock } from '../src/index';
import { linkClickedEventSchema } from '../../contracts/src/marketing/share-links';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const ORIGIN = 'https://origin.test';
const SECRET = 'edge-secret-edge-secret-edge-secret-0';
const workerEnv = { ...env, REALTIME_ORIGIN: ORIGIN, KAFKA_BROKER: 'https://kafka.test', SHARE_LINK_EDGE_SECRET: SECRET } as typeof env & {
	SHARE_LINK_EDGE_SECRET: string;
};

let seq = 0;
const freshCode = () => `edge${Date.now().toString(36)}${(seq++).toString(36)}`;

/** Fake origin and fake event sink behind `fetch`; the Worker's own cache is the real runtime cache with a fake clock. */
function fakes() {
	const origin = {
		calls: [] as Array<{ url: string; headers: Headers }>,
		respond: (_url: string): Response => new Response(null, { status: 302, headers: { location: 'https://shop.example/p/a?ref=x' } }),
	};
	const sink = { events: [] as any[], down: false };
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input as RequestInfo, init);
		if (request.url.startsWith(ORIGIN)) {
			origin.calls.push({ url: request.url, headers: request.headers });
			return origin.respond(request.url);
		}
		if (request.url.startsWith('https://kafka.test')) {
			if (sink.down) return new Response('down', { status: 503 });
			const body = (await request.json()) as { records: Array<{ key: string; value: unknown }> };
			sink.events.push(...body.records);
			return new Response('{}', { status: 200 });
		}
		throw new Error(`unexpected fetch ${request.url}`);
	});
	return { origin, sink };
}

async function follow(code: string, headers: Record<string, string> = {}) {
	const ctx = createExecutionContext();
	const response = await worker.fetch(new IncomingRequest(`https://mkt.to/l/${code}`, { headers }), workerEnv as never, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

describe('Edge short-link redirect', () => {
	let now = 1_800_000_000_000;
	beforeEach(() => {
		now = 1_800_000_000_000;
		setEdgeClock(() => now);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		setEdgeClock(() => Date.now());
	});

	it('S37 AS-41: an origin 302 yields one click event in the shared envelope, and the origin is told the click is counted here', async () => {
		const { origin, sink } = fakes();
		const code = freshCode();

		const response = await follow(code, { 'CF-IPCountry': 'DE', Referer: 'https://news.example/private/path?token=1' });

		expect(response.status).toBe(302);
		expect(origin.calls).toHaveLength(1);
		expect(origin.calls[0].headers.get('x-edge-click-recorded')).toBe('1');
		expect(origin.calls[0].headers.get('x-edge-credential')).toBe(SECRET);
		expect(sink.events).toHaveLength(1);
		const { key, value } = sink.events[0];
		expect(key).toBe(code);
		expect(value).toMatchObject({
			type: 'link.clicked',
			version: 1,
			aggregateType: 'links',
			aggregateId: code,
			aggregateVersion: 1,
			occurredAt: new Date(now).toISOString(),
		});
		expect(value.eventId).toBe(value.payload.clickId);
		expect(value.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		// the payload parses with the same schema the backend uses
		expect(linkClickedEventSchema.parse(value.payload)).toEqual({
			clickId: value.eventId,
			code,
			ts: new Date(now).toISOString(),
			country: 'DE',
			referer: 'https://news.example',
			viaEdge: true,
		});
	});

	it('S37 AS-41: country and referer are cleaned like the origin does', async () => {
		const { sink } = fakes();
		await follow(freshCode(), { 'CF-IPCountry': 'XX', Referer: 'not a url' });
		await follow(freshCode(), { 'CF-IPCountry': 'T1', Referer: 'https://a.example:8443/x' });
		expect(sink.events.map((e) => [e.value.payload.country, e.value.payload.referer])).toEqual([
			['', ''],
			['', 'https://a.example:8443'],
		]);
	});

	it('S37 AS-41: a cache hit records a second click with a new id and does not call the origin', async () => {
		const { origin, sink } = fakes();
		const code = freshCode();

		const first = await follow(code);
		const second = await follow(code);

		expect([first.status, second.status]).toEqual([302, 302]);
		expect(second.headers.get('location')).toBe(first.headers.get('location'));
		expect(origin.calls).toHaveLength(1);
		expect(sink.events).toHaveLength(2);
		expect(sink.events[0].value.payload.clickId).not.toBe(sink.events[1].value.payload.clickId);
	});

	it.each([404, 410, 503])('S37 AS-41: an origin %s records nothing and is not cached', async (status) => {
		const { origin, sink } = fakes();
		origin.respond = () => new Response('nope', { status });
		const code = freshCode();

		const first = await follow(code);
		const second = await follow(code);

		expect([first.status, second.status]).toEqual([status, status]);
		expect(origin.calls).toHaveLength(2);
		expect(sink.events).toEqual([]);
	});

	it('S37 AS-41: a failing sink never turns the redirect into an error', async () => {
		const { sink } = fakes();
		sink.down = true;
		const response = await follow(freshCode());
		expect(response.status).toBe(302);
		expect(sink.events).toEqual([]);
	});

	it('S37 AS-42: the cached 302 is served for less than 10 s; at 10 s the origin is asked again and its new answer wins', async () => {
		const { origin } = fakes();
		const code = freshCode();
		origin.respond = () => new Response(null, { status: 302, headers: { location: 'https://shop.example/p/old' } });

		expect((await follow(code)).headers.get('location')).toBe('https://shop.example/p/old');
		origin.respond = () => new Response(null, { status: 302, headers: { location: 'https://shop.example/p/new' } });

		now += 9_999;
		expect((await follow(code)).headers.get('location')).toBe('https://shop.example/p/old');
		expect(origin.calls).toHaveLength(1);

		now += 1; // t0 + 10 s
		expect((await follow(code)).headers.get('location')).toBe('https://shop.example/p/new');
		expect(origin.calls).toHaveLength(2);
	});

	it('S37 AS-42: when the origin starts answering 410 the edge stops serving the old redirect after 10 s', async () => {
		const { origin } = fakes();
		const code = freshCode();
		await follow(code);
		origin.respond = () => new Response('gone', { status: 410 });
		now += 10_000;
		expect((await follow(code)).status).toBe(410);
	});
});
