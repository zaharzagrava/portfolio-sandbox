import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, * as edge from '../src/index';
import vectors from '../../contracts/src/analytics/ingest-vectors.json';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const workerEnv = { ...env, REALTIME_ORIGIN: 'https://origin.test', KAFKA_BROKER: 'https://kafka.test', UPSTASH_REDIS_REST_URL: 'https://redis.test' } as never;

type Vector = {
	name: string;
	now: number;
	request: { headers: Record<string, string>; body?: unknown; rawBody?: string };
	expect: { status: number; accepted?: number; rejected?: { index: number; code: string }[]; stored?: Record<string, unknown>[] };
};
const VECTORS = vectors as unknown as Vector[];
const CORE = ['event_id', 'name', 'anonymous_id', 'ts', 'received_at', 'page', 'props'] as const;

interface Fakes {
	produced: Array<{ key: string; value: Record<string, unknown> }>;
	produceCalls: number;
	/** Decides each produce call (1-based); throw/resolve a promise to simulate. */
	onProduce: (call: number) => Promise<void> | void;
	limiter: 'allow' | 'deny' | 'error';
}

function fakes(): Fakes {
	const state: Fakes = { produced: [], produceCalls: 0, onProduce: () => undefined, limiter: 'allow' };
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input as RequestInfo, init);
		if (request.url.startsWith('https://redis.test')) {
			if (state.limiter === 'error') throw new Error('redis down');
			return new Response(JSON.stringify({ result: state.limiter === 'allow' ? [1, 100, 1000] : [0, 0, 12_000] }));
		}
		if (request.url.startsWith('https://kafka.test')) {
			const body = (await request.json()) as { records: Array<{ key: string; value: Record<string, unknown> }> };
			state.produceCalls++;
			await state.onProduce(state.produceCalls);
			state.produced.push(...body.records);
			return new Response('{}', { status: 200 });
		}
		throw new Error(`unexpected fetch ${request.url}`);
	});
	return state;
}

async function post(body: string, headers: Record<string, string> = {}, { wait = true }: { wait?: boolean } = {}) {
	const ctx = createExecutionContext();
	const response = await worker.fetch(new IncomingRequest('https://edge.test/collect', { method: 'POST', body, headers }), workerEnv, ctx);
	if (wait) await waitOnExecutionContext(ctx);
	return { response, ctx };
}

const event = (n: number, extra: Record<string, unknown> = {}) => ({
	event_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
	name: 'page_view',
	anonymous_id: 'anon-12345678',
	ts: 1_759_999_999_000,
	...extra,
});
const NOW = 1_760_000_000_000;

describe('Edge collector (S39)', () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		edge.collectHooks.random = () => 0.5;
		edge.collectHooks.sleep = async () => undefined;
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	for (const vector of VECTORS) {
		it(`S39 AS-10: shared vector "${vector.name}" is judged like the backend`, async () => {
			vi.setSystemTime(vector.now);
			const sink = fakes();
			const raw = vector.request.rawBody ?? JSON.stringify(vector.request.body);
			const { response } = await post(raw, vector.request.headers);

			expect(response.status).toBe(vector.expect.status);
			if (vector.expect.status !== 202) {
				expect(sink.produced).toEqual([]);
				return;
			}
			expect(await response.json()).toEqual({ accepted: vector.expect.accepted, rejected: vector.expect.rejected });
			expect(sink.produced.map((r) => r.key)).toEqual(sink.produced.map((r) => r.value.anonymous_id));
			expect(sink.produced.map((r) => Object.fromEntries(CORE.map((k) => [k, r.value[k]])))).toEqual(vector.expect.stored);
			for (const r of sink.produced) expect(r.value).toMatchObject({ user_id: '', country: '', platform: 'web' });
		});
	}

	it('S39 AS-10: 202 is returned before the producer resolves', async () => {
		const sink = fakes();
		let release!: () => void;
		sink.onProduce = () => new Promise<void>((resolve) => (release = resolve));
		const { response, ctx } = await post(JSON.stringify({ events: [event(1)] }), {}, { wait: false });
		expect(response.status).toBe(202);
		expect(sink.produced).toEqual([]);
		await vi.waitFor(() => expect(sink.produceCalls).toBe(1));
		release();
		await waitOnExecutionContext(ctx);
		expect(sink.produced).toHaveLength(1);
	});

	it('S39 AS-10: a produce failing twice is retried with full-jitter sleeps under the cap and nothing is counted', async () => {
		const sink = fakes();
		const sleeps: number[] = [];
		edge.collectHooks.sleep = async (ms) => void sleeps.push(ms);
		edge.collectHooks.random = () => 0.999;
		sink.onProduce = (call) => {
			if (call <= 2) throw new Error('boom');
		};
		const before = edge.edgeProduceStats.failedEvents;
		await post(JSON.stringify({ events: [event(1)] }));
		expect(sink.produceCalls).toBe(3);
		expect(sink.produced).toHaveLength(1);
		expect(sleeps).toHaveLength(2);
		expect(sleeps.every((ms) => ms >= 0 && ms <= 1000)).toBe(true);
		expect(sleeps[0]).toBeLessThanOrEqual(100 * 2 ** 0);
		expect(sleeps[1]).toBeLessThanOrEqual(100 * 2 ** 1);
		expect(edge.edgeProduceStats.failedEvents).toBe(before);
	});

	it('S39 AS-10: a produce failing three times counts the lost events once and logs without content', async () => {
		const sink = fakes();
		sink.onProduce = () => {
			throw new Error('boom');
		};
		const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const before = edge.edgeProduceStats.failedEvents;
		await post(JSON.stringify({ events: [event(1), event(2)] }));
		expect(edge.edgeProduceStats.failedEvents).toBe(before + 2);
		expect(errors).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(errors.mock.calls)).not.toContain('anon-12345678');
	});

	it('S39 FR-007: a body over 128 KiB is 413 and produces nothing', async () => {
		const sink = fakes();
		const { response } = await post(JSON.stringify({ events: [event(1, { page: 'x'.repeat(129 * 1024) })] }));
		expect(response.status).toBe(413);
		expect((await response.json()) as { code: string }).toMatchObject({ code: 'payload_too_large' });
		expect(sink.produced).toEqual([]);
	});

	it('S39 FR-008: more than 50 events is a 400, not cut', async () => {
		const sink = fakes();
		const { response } = await post(JSON.stringify({ events: Array.from({ length: 51 }, (_, i) => event(i + 1)) }));
		expect(response.status).toBe(400);
		expect((await response.json()) as { code: string }).toMatchObject({ code: 'validation_failed' });
		expect(sink.produced).toEqual([]);
	});

	it.each([
		['de', ''],
		['XX', ''],
		['DE', 'DE'],
	])('S39 FR-009: CF-IPCountry %s is stored as %j', async (header, stored) => {
		const sink = fakes();
		await post(JSON.stringify({ events: [event(1)] }), { 'CF-IPCountry': header });
		expect(sink.produced[0].value.country).toBe(stored);
	});

	it.each([
		['server', 'web'],
		['toaster', 'web'],
		['ios', 'ios'],
	])('S39 FR-009: X-Client-Platform %s is stored as %s', async (header, stored) => {
		const sink = fakes();
		await post(JSON.stringify({ events: [event(1)] }), { 'X-Client-Platform': header });
		expect(sink.produced[0].value.platform).toBe(stored);
	});

	it('S39 AS-10: the rate limiter denying answers 429 with Retry-After and produces nothing', async () => {
		const sink = fakes();
		sink.limiter = 'deny';
		const { response } = await post(JSON.stringify({ events: [event(1)] }));
		expect(response.status).toBe(429);
		expect(response.headers.get('Retry-After')).toBe('12');
		expect(sink.produced).toEqual([]);
	});

	it('S39 AS-10: a limiter store error fails open', async () => {
		const sink = fakes();
		sink.limiter = 'error';
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const before = edge.edgeRateLimitStats.failOpen;
		const { response } = await post(JSON.stringify({ events: [event(1)] }));
		expect(response.status).toBe(202);
		expect(edge.edgeRateLimitStats.failOpen).toBe(before + 1);
		expect(sink.produced).toHaveLength(1);
	});
});
