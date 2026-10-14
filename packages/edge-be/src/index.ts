import { loaderScript } from './widget-loader';
import {
	INGEST_LIMITS,
	readEnvelope,
	sanitizeCountry,
	sanitizePlatform,
	toStoredMessage,
	validateIngestBatch,
	type StoredEventMessage,
} from '../../contracts/src/analytics/ingest-rules';
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
	/** S37: shared with the origin (`share_link_edge_secret`, at least 32 bytes). A Worker secret: `wrangler secret put SHARE_LINK_EDGE_SECRET`. */
	SHARE_LINK_EDGE_SECRET: string;
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
export const SLIDING_WINDOW_LUA = `
local limit = tonumber(ARGV[1])
local W = tonumber(ARGV[2])
local elapsed = tonumber(ARGV[3])
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local previous = tonumber(redis.call('GET', KEYS[2]) or '0')
local used = previous * (W - elapsed) + current * W
if used + W <= limit * W then
  redis.call('INCR', KEYS[1])
  redis.call('PEXPIRE', KEYS[1], W * 2)
  return { 1, math.floor((limit * W - used - W) / W), W - elapsed }
end
local retry
local room = (limit - current - 1) * W
if room >= 0 then
  retry = (W - math.floor(room / previous)) - elapsed
else
  local e3 = 0
  if current > 0 then
    e3 = W - math.floor((limit - 1) * W / current)
    if e3 < 0 then e3 = 0 end
  end
  retry = (W - elapsed) + e3
end
if retry < 1 then retry = 1 end
return { 0, 0, retry }
`;

export interface EdgeDecision {
	allowed: boolean;
	remaining: number;
	/** ms until a request would be admitted (denial) or until the window rolls (allowed). */
	resetMs: number;
}

/** Fail-open decisions since this isolate started: the edge has no metrics pipeline, so they are counted here and logged. */
export const edgeRateLimitStats = { failOpen: 0 };

const POLICY_NAME = 'edge';

/**
 * One atomic store call per decision, 500 ms timeout. Any failure (error, timeout, malformed answer) admits the
 * request: the backend's own limits still apply behind the edge (FR-057).
 */
async function checkRateLimit(subject: string, env: Env): Promise<EdgeDecision> {
	const windowMs = RATE_LIMIT_WINDOW_SECONDS * 1000;
	const now = Date.now();
	const window = Math.floor(now / windowMs);
	const base = `ratelimit:{${subject}}`;

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
		const data = (await response.json()) as { result?: [number, number, number] };
		const [allowed, remaining, resetMs] = (data.result ?? []).map(Number);
		if (![allowed, remaining, resetMs].every(Number.isFinite)) throw new Error('malformed answer');
		return { allowed: allowed === 1, remaining, resetMs };
	} catch (error) {
		edgeRateLimitStats.failOpen++;
		console.warn(JSON.stringify({ event: 'edge_rate_limit_fail_open', reason: (error as Error)?.name ?? 'error' }));
		return { allowed: true, remaining: RATE_LIMIT_MAX_REQUESTS, resetMs: 0 };
	}
}

/** The one 429 of the edge: problem+json and the RateLimit headers of the backend contract (FR-058). Never names the subject. */
function rateLimitResponse(decision: EdgeDecision, request: Request): Response {
	const retryAfterSeconds = Math.max(1, Math.ceil(decision.resetMs / 1000));
	const url = new URL(request.url);
	return new Response(
		JSON.stringify({
			type: 'https://errors.marketplace.invalid/rate_limited',
			title: 'Too Many Requests',
			status: 429,
			detail: `Too many requests. Retry in ${retryAfterSeconds}s.`,
			instance: url.pathname,
			code: 'rate_limited',
			retryAfterSeconds,
		}),
		{
			status: 429,
			headers: {
				'Content-Type': 'application/problem+json',
				'Retry-After': String(retryAfterSeconds),
				'RateLimit-Policy': `"${POLICY_NAME}";q=${RATE_LIMIT_MAX_REQUESTS};w=${RATE_LIMIT_WINDOW_SECONDS}`,
				RateLimit: `"${POLICY_NAME}";r=0;t=${retryAfterSeconds}`,
				'Cache-Control': 'no-store',
			},
		},
	);
}

/** Verified user id, else the address the CDN reports, else one shared bucket (FR-058). Never a client-set forwarding header. */
async function rateLimitSubject(request: Request, env: Env): Promise<string> {
	const userId = await tryGetUserId(request, env);
	if (userId) return `user:${userId}`;
	const address = request.headers.get('CF-Connecting-IP');
	return address ? `ip:${address}` : 'anonymous';
}

function isProxiedReadPath(pathname: string): boolean {
	return (
		pathname.startsWith('/api/products/search') ||
		pathname.startsWith('/api/payments')
	);
}

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

/** The clock the age of a cached redirect is read from; tests move it (S37 AS-42). */
let edgeNow: () => number = () => Date.now();
export function setEdgeClock(clock: () => number): void {
	edgeNow = clock;
}

/** A cached 302 is served for less than the origin's `s-maxage` (S37 FR-064). */
const SHORT_LINK_TTL_MS = 10_000;
const CACHED_AT = 'x-edge-cached-at';

/** UUID version 7: 48-bit millisecond timestamp first, so click ids sort by time (the same scheme as the origin). */
function uuidv7(ms: number): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	let t = BigInt(ms);
	for (let i = 5; i >= 0; i--) {
		bytes[i] = Number(t & 0xffn);
		t >>= 8n;
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x70;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Two upper-case letters, never Cloudflare's `XX` (unknown) or `T1` (Tor); anything else is "" (mirrors the origin). */
function cleanCountry(raw: string | null): string {
	return raw !== null && /^[A-Z]{2}$/.test(raw) && raw !== 'XX' ? raw : '';
}

/** Origin (scheme, host, port) of the Referer, at most 300 characters; never path, query or credentials. */
function refererOrigin(raw: string | null): string {
	if (!raw) return '';
	try {
		const url = new URL(raw);
		if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
		return url.origin.length <= 300 ? url.origin : '';
	} catch {
		return '';
	}
}

/** One `link.clicked` v1 record, field for field what the backend emits (`contracts/events.md`). */
function recordClick(code: string, request: Request, env: Env, ctx: ExecutionContext): void {
	const ms = edgeNow();
	const at = new Date(ms).toISOString();
	const clickId = uuidv7(ms);
	ctx.waitUntil(
		produceToKafka(env, 'links.events', code, {
			eventId: clickId,
			type: 'link.clicked',
			version: 1,
			aggregateType: 'links',
			aggregateId: code,
			aggregateVersion: 1,
			occurredAt: at,
			payload: {
				clickId,
				code,
				ts: at,
				country: cleanCountry(request.headers.get('CF-IPCountry')),
				referer: refererOrigin(request.headers.get('Referer')),
				viaEdge: true,
			},
		}).catch((e) => console.error('click event dropped', e instanceof Error ? e.name : 'error')),
	);
}

/**
 * Short-link redirects never reach the origin when hot (lesson 10/05 #8):
 *  - a click is recorded HERE only for a 302 this Worker actually serves (a cache hit or an origin 302), fire-and-forget
 *    (`waitUntil` - the visitor's 302 doesn't wait for Kafka); 404, 410 and 5xx record nothing and are never cached;
 *  - the 302 is cached for at most the origin's `s-maxage` (10 s, read from an injectable clock), so a viral link
 *    costs the origin one request per PoP per 10 s;
 *  - origin calls carry `x-edge-click-recorded` and the shared credential, which is the only thing that makes the
 *    origin believe the flag (S37 FR-063).
 */
async function shortLinkRedirect(code: string, request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const cache = caches.default;
	const cacheKey = new Request(`${env.REALTIME_ORIGIN}/api/l/${code}`, { method: 'GET' });
	const cached = await cache.match(cacheKey);
	if (cached) {
		const cachedAt = Number(cached.headers.get(CACHED_AT));
		if (Number.isFinite(cachedAt) && edgeNow() - cachedAt < SHORT_LINK_TTL_MS) {
			const response = new Response(null, cached);
			response.headers.delete(CACHED_AT);
			recordClick(code, request, env, ctx);
			return response;
		}
	}

	const upstream = await fetch(cacheKey.url, {
		redirect: 'manual',
		headers: { 'x-edge-click-recorded': '1', 'x-edge-credential': env.SHARE_LINK_EDGE_SECRET },
	});
	const response = new Response(upstream.body, upstream);
	if (upstream.status === 302) {
		recordClick(code, request, env, ctx);
		const stored = new Response(null, upstream);
		stored.headers.set(CACHED_AT, String(edgeNow()));
		stored.headers.set('Cache-Control', 'public, s-maxage=10');
		ctx.waitUntil(cache.put(cacheKey, stored));
	}
	return response;
}

// --- --- --- --- --- SD-31 analytics ingest at the edge --- --- --- --- --- //

/** Events that could not be produced after every attempt, since this isolate started (no metrics pipeline at the edge). */
export const edgeProduceStats = { failedEvents: 0 };

/** Sleep and random source of the produce retry; tests replace them so nothing really waits. */
export const collectHooks = {
	sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
	random: (): number => Math.random(),
};

const PRODUCE_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 100;
const BACKOFF_CAP_MS = 1000;

function problem(status: number, code: string, title: string): Response {
	return new Response(JSON.stringify({ status, code, title }), { status, headers: { 'Content-Type': 'application/problem+json' } });
}

/** Produces every message (keyed by anonymous_id), retrying the whole group up to 3 times with full-jitter backoff. */
async function produceAnalytics(env: Env, messages: StoredEventMessage[]): Promise<void> {
	for (let attempt = 0; attempt < PRODUCE_ATTEMPTS; attempt++) {
		try {
			await Promise.all(messages.map((m) => produceToKafka(env, 'analytics.events', m.anonymous_id, m)));
			return;
		} catch {
			if (attempt < PRODUCE_ATTEMPTS - 1) {
				await collectHooks.sleep(collectHooks.random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt));
			}
		}
	}
	edgeProduceStats.failedEvents += messages.length;
	console.error(JSON.stringify({ event: 'edge_analytics_produce_failed', events: messages.length }));
}

/**
 * POST /collect - the browser's `navigator.sendBeacon` target (text/plain, no preflight). Judges the batch with the
 * rules shared with the backend fallback (packages/contracts/src/analytics/ingest-rules.ts, pinned by
 * ingest-vectors.json), enriches (country from Cloudflare, user from the JWT if present), answers 202 immediately and
 * produces to Kafka in `waitUntil`: 200k events/s never reach the origin.
 */
async function collect(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const decision = await checkRateLimit(await rateLimitSubject(request, env), env);
	if (!decision.allowed) return rateLimitResponse(decision, request);

	const text = await request.text();
	if (new TextEncoder().encode(text).byteLength > INGEST_LIMITS.bodyBytes) return problem(413, 'payload_too_large', 'Payload Too Large');
	let events: unknown[] | null;
	try {
		events = readEnvelope(JSON.parse(text));
	} catch {
		events = null;
	}
	if (!events) return problem(400, 'validation_failed', 'Bad Request');

	const { accepted, rejected } = validateIngestBatch(events, { now: Date.now() });
	if (accepted.length) {
		const meta = {
			userId: (await tryGetUserId(request, env)) ?? '',
			country: sanitizeCountry(request.headers.get('CF-IPCountry')),
			platform: sanitizePlatform(request.headers.get('X-Client-Platform')),
		};
		ctx.waitUntil(produceAnalytics(env, accepted.map((event) => toStoredMessage(event, meta))));
	}
	return new Response(JSON.stringify({ accepted: accepted.length, rejected }), { status: 202, headers: { 'Content-Type': 'application/json' } });
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
			const decision = await checkRateLimit(await rateLimitSubject(request, env), env);
			if (!decision.allowed) return rateLimitResponse(decision, request);

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

		// The payment write path (`payments.requests` through Kafka) is gone: S13 accepts payments at POST /api/payments/intents on the origin.
		return new Response(request.method === 'GET' ? 'Not found' : 'Method not allowed', { status: request.method === 'GET' ? 404 : 405 });
	},
};
