import { loaderScript } from './widget-loader';
import { createRemoteJWKSet, decodeProtectedHeader, importSPKI, jwtVerify, type JWTPayload } from 'jose';

export interface Env {
	UPSTASH_REDIS_REST_URL: string;
	UPSTASH_REDIS_REST_TOKEN: string;
	KAFKA_BROKER: string;
	JWT_PUBLIC_KEY: string;
	/** SD-39: backend JWKS (https://api.../.well-known/jwks.json) for rotating ES256 keys. */
	JWKS_URL?: string;
	KAFKA_CLUSTER_ID?: string;
	KAFKA_API_KEY?: string;
	KAFKA_API_SECRET?: string;
	REALTIME_ORIGIN: string;
}

const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_MAX_REQUESTS = 120;

/** Best-effort userId extraction — returns null instead of throwing, since
 * anonymous requests (e.g. product search) are allowed and fall back to IP. 
 * // See README.md#adr -> "How do you draw a line of what to put into a Cloudflare worker?"
 */
async function tryGetUserId(request: Request, env: Env): Promise<string | null> {
	try {
		const { userId } = await authenticateRequest(request, env);
		return userId;
	} catch {
		return null;
	}
}

/** Sliding-window counter at the edge (SD-28): weighted previous + current
 * window, evaluated atomically in ONE Upstash round trip via EVAL. The old
 * fixed window (INCR + separate EXPIRE) allowed 2x the limit across a window
 * boundary and could leave a key without TTL if the second call failed.
 * Fail-open: an Upstash outage must not take the whole edge down - the
 * backend's own per-endpoint limits (fail-closed where it matters) still apply.
 * // See README.md#adr -> "Why use Redis at the edge?"
 */
const SLIDING_WINDOW_LUA = `
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local elapsed = tonumber(ARGV[3])
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local previous = tonumber(redis.call('GET', KEYS[2]) or '0')
local estimate = previous * (1 - elapsed / window) + current
if estimate + 1 > limit then return 0 end
redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], window * 2)
return 1
`;

async function checkRateLimit(rateLimitKey: string, env: Env): Promise<boolean> {
	const windowMs = RATE_LIMIT_WINDOW_SECONDS * 1000;
	const now = Date.now();
	const window = Math.floor(now / windowMs);
	const base = `ratelimit:{${rateLimitKey}}`;

	try {
		const response = await fetch(env.UPSTASH_REDIS_REST_URL, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify([
				'EVAL',
				SLIDING_WINDOW_LUA,
				'2',
				`${base}:${window}`,
				`${base}:${window - 1}`,
				String(RATE_LIMIT_MAX_REQUESTS),
				String(windowMs),
				String(now % windowMs),
			]),
			signal: AbortSignal.timeout(500),
		});
		const data = (await response.json()) as { result?: number };
		return Number(data.result) === 1;
	} catch {
		return true;
	}
}

function isProxiedReadPath(pathname: string): boolean {
	return (
		pathname.startsWith('/api/products/search') ||
		pathname.startsWith('/api/payment')
	);
}

const UUID_V7_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Module-level caches survive across requests within one isolate.
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let legacyKey: CryptoKey | undefined;

async function authenticateRequest(request: Request, env: Env): Promise<{ userId: string }> {
	const authHeader = request.headers.get('Authorization');
	if (!authHeader || !authHeader.startsWith('Bearer ')) {
		throw new Error('Missing or malformed Authorization header');
	}

	const token = authHeader.split(' ')[1];

	try {
		const { kid } = decodeProtectedHeader(token);
		let payload: JWTPayload;

		if (kid && env.JWKS_URL) {
			// SD-39 rotating keys: jose caches the JWKS per isolate and refetches on an unknown kid.
			// Algorithms pinned - never trust the token's own `alg`.
			jwks ??= createRemoteJWKSet(new URL(env.JWKS_URL), { cacheMaxAge: 300_000, cooldownDuration: 30_000 });
			({ payload } = await jwtVerify(token, jwks, { algorithms: ['ES256', 'RS256'], issuer: 'marketplace' }));
		} else {
			// Legacy static RS256 key (tokens without kid).
			legacyKey ??= await importSPKI(env.JWT_PUBLIC_KEY.replace(/\\n/g, '\n'), 'RS256');
			({ payload } = await jwtVerify(token, legacyKey, { algorithms: ['RS256'] }));
		}

		// Purpose-scoped tokens (MFA challenge) are not access tokens.
		if (payload.purpose) {
			throw new Error('Not an access token');
		}

		if (!payload.sub) {
			throw new Error('JWT is missing subject (user ID)');
		}

		return { userId: payload.sub }; // 'sub' is the standard JWT claim for User ID
	} catch (error) {
		console.error('Error authenticating request', error);
		throw new Error('Invalid or expired token');
	}
}

function generateTraceparent(): string {
	// 1. Generate standard W3C 16-byte Trace ID and 8-byte Span ID
	const traceId = crypto.randomUUID().replace(/-/g, '');
	const spanId = crypto.randomUUID().replace(/-/g, '').substring(0, 16);

	// 2. Format it exactly like this: 00-{traceId}-{spanId}-01
	const traceparent = `00-${traceId}-${spanId}-01`;

	return traceparent;
}
export interface PaymentPayload {
	idempotency_key: string;
	amount: number;
	bisOrderId: string;
	paymentMethodId: string;
}

export function validatePaymentPayload(body: any): { isValid: boolean; errors: string[]; data?: PaymentPayload } {
	const errors: string[] = [];

	if (!body || typeof body !== 'object') {
		return { isValid: false, errors: ['Payload must be a valid JSON object'] };
	}

	// 1. Validate idempotency_key
	if (typeof body.idempotency_key !== 'string' || body.idempotency_key.trim() === '') {
		errors.push('idempotency_key must be a non-empty string');
	}

	// 2. Validate amount (assuming it must be a positive integer/cents)
	if (typeof body.amount !== 'number' || body.amount <= 0 || !Number.isInteger(body.amount)) {
		errors.push('amount must be a positive integer');
	}

	// 4. Validate bisOrderId (UUID)
	if (typeof body.bisOrderId !== 'string' || !UUID_V7_REGEX.test(body.bisOrderId)) {
		errors.push('bisOrderId must be a valid UUID');
	}

	// 5. Validate paymentMethodId
	if (typeof body.paymentMethodId !== 'string' || body.paymentMethodId.trim() === '') {
		errors.push('paymentMethodId must be a non-empty string');
	}

	if (errors.length > 0) {
		return { isValid: false, errors };
	}

	// Return the safely typed data
	return {
		isValid: true,
		errors: [],
		data: {
			idempotency_key: body.idempotency_key,
			amount: body.amount,
			bisOrderId: body.bisOrderId,
			paymentMethodId: body.paymentMethodId,
		},
	};
}

// --- --- --- --- --- SD-08 share links at the edge --- --- --- --- --- //

const SHORT_LINK = /^\/l\/([A-Za-z0-9-]{4,32})$/;

/** Produces one JSON record to Kafka through Confluent REST v3 or Redpanda's Pandaproxy (same switch as payments). */
async function produceToKafka(env: Env, topic: string, key: string, value: unknown): Promise<void> {
	const isConfluent = env.KAFKA_BROKER.includes('confluent.cloud');
	const res = isConfluent
		? await fetch(`${env.KAFKA_BROKER}/kafka/v3/clusters/${env.KAFKA_CLUSTER_ID}/topics/${topic}/records`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: `Basic ${btoa(`${env.KAFKA_API_KEY}:${env.KAFKA_API_SECRET}`)}` },
				body: JSON.stringify({ key: { type: 'JSON', data: key }, value: { type: 'JSON', data: value } }),
			})
		: await fetch(`${env.KAFKA_BROKER}/topics/${topic}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/vnd.kafka.json.v2+json', Accept: 'application/vnd.kafka.v2+json' },
				body: JSON.stringify({ records: [{ key, value }] }),
			});
	if (!res.ok) throw new Error(`kafka produce ${topic}: ${res.status}`);
}

/**
 * Short-link redirects never reach the origin when hot (lesson 10/05 #8):
 *  - the click is recorded HERE, fire-and-forget (`waitUntil` - the visitor's
 *    302 doesn't wait for Kafka), as the same event envelope the backend emits;
 *  - the 302 is cached at the edge for the origin's `s-maxage` (10 s), so a viral
 *    link costs the origin one request per PoP per 10 s;
 *  - origin calls carry `x-edge-click-recorded` so the click isn't counted twice.
 */
async function shortLinkRedirect(code: string, request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const now = new Date().toISOString();
	const clickId = crypto.randomUUID();
	ctx.waitUntil(
		produceToKafka(env, 'links.events', code, {
			eventId: clickId,
			eventName: 'link.clicked',
			aggregateType: 'links',
			aggregateId: code,
			version: 0,
			occurredAt: now,
			schemaVersion: 1,
			payload: { clickId, code, ts: now, country: request.headers.get('CF-IPCountry') ?? '', referer: (request.headers.get('Referer') ?? '').slice(0, 300), viaEdge: true },
		}).catch((e) => console.error('click event dropped', e)),
	);

	const cache = caches.default;
	const cacheKey = new Request(`${env.REALTIME_ORIGIN}/api/l/${code}`, { method: 'GET' });
	const cached = await cache.match(cacheKey);
	if (cached) return cached;

	const upstream = await fetch(cacheKey.url, { redirect: 'manual', headers: { 'x-edge-click-recorded': '1' } });
	const response = new Response(upstream.body, upstream);
	if (upstream.status === 302) ctx.waitUntil(cache.put(cacheKey, response.clone()));
	return response;
}

// --- --- --- --- --- SD-31 analytics ingest at the edge --- --- --- --- --- //

/** Mirrors packages/backend/libs/common/src/analytics/event-schema.ts (kept in sync by hand - no shared package across runtimes). */
const EVENT_NAMES = new Set(['page_view', 'product_view', 'search', 'add_to_cart', 'checkout_step', 'exposure', 'click']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_EVENT_AGE_MS = 7 * 86_400_000;
const MAX_CLOCK_SKEW_MS = 10 * 60_000;

type RawEvent = { event_id?: unknown; name?: unknown; anonymous_id?: unknown; ts?: unknown; page?: unknown; props?: unknown };

const chTime = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');

/**
 * POST /collect - the browser's `navigator.sendBeacon` target (text/plain, no
 * preflight). Validates, enriches (country from Cloudflare, user from the JWT
 * if present), answers 202 immediately and produces to Kafka in `waitUntil`:
 * 200k events/s never reach the origin.
 */
async function collect(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	let body: { events?: RawEvent[] };
	try {
		body = JSON.parse(await request.text());
	} catch {
		return new Response('invalid json', { status: 400 });
	}
	const events = Array.isArray(body.events) ? body.events.slice(0, 50) : [];
	const now = Date.now();
	const userId = (await tryGetUserId(request, env)) ?? '';
	const country = request.headers.get('CF-IPCountry') ?? '';
	const platform = request.headers.get('X-Client-Platform') ?? 'web';

	const valid = events.flatMap((e) => {
		if (typeof e.event_id !== 'string' || !UUID_RE.test(e.event_id)) return [];
		if (typeof e.name !== 'string' || !EVENT_NAMES.has(e.name)) return [];
		if (typeof e.anonymous_id !== 'string' || e.anonymous_id.length < 8 || e.anonymous_id.length > 64) return [];
		if (typeof e.ts !== 'number' || e.ts < now - MAX_EVENT_AGE_MS) return [];
		const props = e.props && typeof e.props === 'object' ? Object.entries(e.props as Record<string, unknown>).slice(0, 30) : [];
		return [
			{
				event_id: e.event_id,
				name: e.name,
				anonymous_id: e.anonymous_id,
				user_id: userId,
				ts: chTime(e.ts > now + MAX_CLOCK_SKEW_MS ? now : e.ts),
				received_at: chTime(now),
				country,
				platform,
				page: typeof e.page === 'string' ? e.page.slice(0, 500) : '',
				props: Object.fromEntries(props.map(([k, v]) => [k.slice(0, 64), String(v).slice(0, 500)])),
			},
		];
	});

	if (valid.length) ctx.waitUntil(Promise.all(valid.map((e) => produceToKafka(env, 'analytics.events', e.anonymous_id, e))).catch((err) => console.error('analytics produce failed', err)));
	return new Response(JSON.stringify({ accepted: valid.length, rejected: events.length - valid.length }), { status: 202, headers: { 'Content-Type': 'application/json' } });
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === 'POST' && url.pathname === '/collect') return collect(request, env, ctx);

		// SD-01: the embeddable loader - pure CDN asset, short TTL so a fix (or a version kill) propagates in minutes.
		if (request.method === 'GET' && url.pathname === '/widget/v1/loader.js') {
			return new Response(loaderScript(env.REALTIME_ORIGIN), {
				headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300, s-maxage=300', 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' },
			});
		}

		const shortLink = request.method === 'GET' ? SHORT_LINK.exec(url.pathname) : null;
		if (shortLink) return shortLinkRedirect(shortLink[1], request, env, ctx);

		// --- --- --- --- --- Proxy sync reads to realtime --- --- --- --- --- //
		// Transparent proxy for now (no edge-side caching) — this exists so the
		// edge is the single ingress applying auth + rate limiting uniformly
		// across both the async write path and the sync read path.
		if (request.method === 'GET' && isProxiedReadPath(url.pathname)) {
			const rateLimitKey = (await tryGetUserId(request, env)) ?? request.headers.get('CF-Connecting-IP') ?? 'anonymous';
			const withinLimit = await checkRateLimit(rateLimitKey, env);
			if (!withinLimit) {
				return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), { status: 429 });
			}

			const upstreamUrl = `${env.REALTIME_ORIGIN}${url.pathname}${url.search}`;
			const upstreamResponse = await fetch(upstreamUrl, {
				method: 'GET',
				headers: request.headers,
			});

			return new Response(upstreamResponse.body, {
				status: upstreamResponse.status,
				headers: upstreamResponse.headers,
			});
		}

		if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

		try {
			// --- --- --- --- --- Validation --- --- --- --- --- //
			const rawBody = await request.text();
			let body = JSON.parse(rawBody);

			try {
				body = JSON.parse(rawBody);
			} catch (e) {
				return new Response(JSON.stringify({ error: 'Invalid JSON format' }), { status: 400 });
			}

			// Run the raw JS validator
			const validation = validatePaymentPayload(body);

			if (!validation.isValid) {
				// Fail fast and tell the frontend exactly what they did wrong
				return new Response(
					JSON.stringify({
						error: 'Validation failed',
						details: validation.errors,
					}),
					{
						status: 400,
						headers: { 'Content-Type': 'application/json' },
					},
				);
			}

			// Now you can safely use validation.data knowing it is 100% correct
			const safePayload = validation.data;

			if (!safePayload) {
				return new Response(JSON.stringify({ error: 'Invalid payload' }), { status: 400 });
			}

			// --- --- --- --- --- Authentication --- --- --- --- --- //
			const { idempotency_key } = safePayload;

			let userContext;
			try {
				userContext = await authenticateRequest(request, env);
			} catch (authErr: any) {
				return new Response(JSON.stringify({ error: authErr.message }), { status: 401 });
			}

			// --- --- --- --- --- Rate limiting --- --- --- --- --- //
			const withinLimit = await checkRateLimit(userContext.userId, env);
			if (!withinLimit) {
				return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), { status: 429 });
			}

			// --- --- --- --- --- Redis idempotency check --- --- --- --- --- //
			const redisAuth = {
				Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
				'Content-Type': 'application/json',
			};

			const redisKey = `idempotency:${userContext.userId}:${idempotency_key}`;

			const redisCheck = await fetch(`${env.UPSTASH_REDIS_REST_URL}`, {
				method: 'POST',
				headers: redisAuth,
				body: JSON.stringify(['SET', redisKey, 'processing', 'NX', 'EX', 86400]),
			});
			const redisData = (await redisCheck.json()) as any;

			if (redisData.result !== 'OK') {
				return new Response(JSON.stringify({ error: 'Duplicate request detected.' }), { status: 409 });
			}

			// --- --- --- --- --- Sending to Kafka --- --- --- --- --- //

			// Kafka URL and body generation based on the broker type
			console.log('Kafka URL and body generation based on the broker type');
			const isConfluent = env.KAFKA_BROKER.includes('confluent.cloud');
			const traceparent = generateTraceparent();
			const { kafkaUrl, kafkaHeaders, kafkaBody } = (() => {
				let kafkaUrl: string;
				let kafkaHeaders: Record<string, string>;
				let kafkaBody: any;

				const newBody = {
					...body,
					userId: userContext.userId,
				};

				if (isConfluent) {
					kafkaUrl = `${env.KAFKA_BROKER}/kafka/v3/clusters/${env.KAFKA_CLUSTER_ID}/topics/payments.requests/records`;
					kafkaHeaders = {
						'Content-Type': 'application/json',
						Authorization: `Basic ${btoa(`${env.KAFKA_API_KEY}:${env.KAFKA_API_SECRET}`)}`,
					};
					// Confluent REST v3 expects header values as base64
					kafkaBody = {
						key: { type: 'JSON', data: idempotency_key },
						value: { type: 'JSON', data: newBody },
						headers: [{ name: 'traceparent', value: btoa(traceparent) }],
					};
				} else {
					kafkaUrl = `${env.KAFKA_BROKER}/topics/payments.requests`;
					kafkaHeaders = {
						'Content-Type': 'application/vnd.kafka.json.v2+json',
						Accept: 'application/vnd.kafka.v2+json',
					};
					// Must live on the Kafka record — HTTP headers are not forwarded by the proxy
					kafkaBody = {
						records: [
							{
								key: idempotency_key,
								value: newBody,
								headers: [{ name: 'traceparent', value: traceparent }],
							},
						],
					};
				}

				return { kafkaUrl, kafkaHeaders, kafkaBody };
			})();

			console.log('Fetching Kafka response');

			console.log('Kafka URL', kafkaUrl);
			console.log('Kafka headers', kafkaHeaders);
			console.log('Kafka body', kafkaBody);

			const kafkaResponse = await fetch(kafkaUrl, {
				method: 'POST',
				headers: kafkaHeaders,
				body: JSON.stringify(kafkaBody),
			});
			const kafkaPayload = await kafkaResponse.json();

			console.log('Kafka status', kafkaResponse.status);
			console.log('Kafka payload', kafkaPayload);

			if (!kafkaResponse.ok) {
				await fetch(`${env.UPSTASH_REDIS_REST_URL}`, {
					method: 'POST',
					headers: redisAuth,
					body: JSON.stringify(['DEL', redisKey]),
				});
				throw new Error(`Kafka Error: ${await kafkaResponse.text()}`);
			}

			return new Response(JSON.stringify({ status: 'Accepted', idempotencyKey: idempotency_key }), { status: 202 });
		} catch (err: any) {
			return new Response(JSON.stringify({ error: err.message }), { status: 500 });
		}
	},
};
