import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../vitest.setup';
import { auditPageFixture, flagFixture, flagPageFixture, FLAGS_URL, problemBody, staleFixture } from '@/lib/test/flag-fixtures';
import { ApiParseError } from './parse';
import { archiveFlag, getFlag, getFlagHistory, getStaleFlags, killFlag, listFlags, readFlagProblem, restoreFlag, saveFlag } from './admin-flags';

const input = {
  expectedVersion: 3,
  owner: 'a@b.c',
  enabled: false,
  variants: [{ key: 'off', value: false }],
  defaultVariant: 'off',
  offVariant: 'off',
  rules: [],
};

const capture = () => {
  const seen: Request[] = [];
  return { seen, track: ({ request }: { request: Request }) => void seen.push(request.clone()) };
};

afterEach(() => vi.restoreAllMocks());

describe('admin flags API', () => {
  it('W06 AS-56: reads are relative same-origin /api/admin/flags paths, parsed with the contracts, no Authorization', async () => {
    const { seen, track } = capture();
    server.use(
      http.get(FLAGS_URL, (info) => {
        track(info);
        return HttpResponse.json(flagPageFixture([flagFixture()], 'next-1'));
      }),
      http.get(`${FLAGS_URL}/new-checkout`, (info) => {
        track(info);
        return HttpResponse.json(flagFixture());
      }),
    );
    const page = await listFlags({ status: 'killed', cursor: 'c1' });
    expect(page.nextCursor).toBe('next-1');
    expect((await getFlag('new-checkout')).version).toBe(3);
    expect(new URL(seen[0]!.url).search).toBe('?status=killed&cursor=c1');
    for (const request of seen) {
      expect(request.headers.get('authorization')).toBeNull();
      expect(new URL(request.url).origin).toBe('http://localhost:3000');
    }
  });

  it('W06 AS-03: the Archived list sends status=archived and includeArchived=true; "all" sends neither', async () => {
    const urls: string[] = [];
    server.use(http.get(FLAGS_URL, ({ request }) => (urls.push(request.url), HttpResponse.json(flagPageFixture([])))));
    await listFlags({ status: 'archived' });
    await listFlags({ status: 'all' });
    expect(new URL(urls[0]!).searchParams.get('status')).toBe('archived');
    expect(new URL(urls[0]!).searchParams.get('includeArchived')).toBe('true');
    expect(new URL(urls[1]!).search).toBe('');
  });

  it('W06 AS-18: save is a PUT of the whole definition; 201 and 200 are both a flag', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.put(`${FLAGS_URL}/new-checkout`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(flagFixture({ version: 4 }), { status: 200 });
      }),
      http.put(`${FLAGS_URL}/fresh-one`, () => HttpResponse.json(flagFixture({ key: 'fresh-one', version: 1 }), { status: 201, headers: { Location: '/api/admin/flags/fresh-one' } })),
    );
    expect((await saveFlag('new-checkout', input)).version).toBe(4);
    expect((await saveFlag('fresh-one', { ...input, expectedVersion: 0 })).version).toBe(1);
    expect(bodies[0]).toEqual(input);
  });

  it('W06 FR-030: kill, restore and archive are body-less POSTs that answer 204', async () => {
    const seen: { url: string; body: string }[] = [];
    server.use(http.post(`${FLAGS_URL}/:key/:action`, async ({ request }) => (seen.push({ url: new URL(request.url).pathname, body: await request.text() }), new HttpResponse(null, { status: 204 }))));
    await killFlag('new-checkout');
    await restoreFlag('new-checkout');
    await archiveFlag('new-checkout');
    expect(seen).toEqual([
      { url: '/api/admin/flags/new-checkout/kill', body: '' },
      { url: '/api/admin/flags/new-checkout/restore', body: '' },
      { url: '/api/admin/flags/new-checkout/archive', body: '' },
    ]);
  });

  it('W06 AS-56: every non-GET carries the CSRF header', async () => {
    vi.spyOn(document, 'cookie', 'get').mockReturnValue('__Host-bff-csrf=tok123');
    const headers: (string | null)[] = [];
    server.use(
      http.put(`${FLAGS_URL}/new-checkout`, ({ request }) => (headers.push(request.headers.get('x-csrf-token')), HttpResponse.json(flagFixture()))),
      http.post(`${FLAGS_URL}/new-checkout/kill`, ({ request }) => (headers.push(request.headers.get('x-csrf-token')), new HttpResponse(null, { status: 204 }))),
    );
    await saveFlag('new-checkout', input);
    await killFlag('new-checkout');
    expect(headers).toEqual(['tok123', 'tok123']);
  });

  it('W06 AS-40: history and stale are parsed with the contracts schemas and send their parameters', async () => {
    const urls: string[] = [];
    server.use(
      http.get(`${FLAGS_URL}/new-checkout/history`, ({ request }) => (urls.push(request.url), HttpResponse.json(auditPageFixture()))),
      http.get(`${FLAGS_URL}/stale`, ({ request }) => (urls.push(request.url), HttpResponse.json(staleFixture([], 7)))),
    );
    expect((await getFlagHistory('new-checkout', { cursor: 'h1' })).items).toHaveLength(1);
    expect((await getStaleFlags({ days: 7 })).days).toBe(7);
    expect(new URL(urls[0]!).searchParams.get('cursor')).toBe('h1');
    expect(new URL(urls[1]!).searchParams.get('days')).toBe('7');
  });

  it('W06 FR-005: a body that does not match its schema is a failed call (invalid_response)', async () => {
    server.use(http.get(`${FLAGS_URL}/new-checkout`, () => HttpResponse.json({ nonsense: true })));
    await expect(getFlag('new-checkout')).rejects.toBeInstanceOf(ApiParseError);
  });

  it('W06 FR-005: the key is path-encoded', async () => {
    const paths: string[] = [];
    server.use(http.get(`${FLAGS_URL}/:key`, ({ request }) => (paths.push(new URL(request.url).pathname), HttpResponse.json(flagFixture()))));
    await getFlag('a/b');
    expect(paths[0]).toBe('/api/admin/flags/a%2Fb');
  });
});

describe('readFlagProblem', () => {
  const failure = async (status: number, body: unknown, headers: Record<string, string> = {}) => {
    server.use(http.get(`${FLAGS_URL}/new-checkout`, () => HttpResponse.json(body as object, { status, headers })));
    return getFlag('new-checkout').then(
      () => null,
      (error: unknown) => readFlagProblem(error),
    );
  };

  it('W06 R-02: the machine code is read from `code`', async () => {
    expect(await failure(409, problemBody(409, 'version_conflict', { currentVersion: 5 }))).toMatchObject({ status: 409, code: 'version_conflict', currentVersion: 5, requestId: 'req-test' });
  });

  it('W06 R-02: else from the tail of `type`', async () => {
    const body = { type: 'https://errors.example/problems/flag_killed', title: 't', status: 409 };
    expect((await failure(409, body))?.code).toBe('flag_killed');
  });

  it('W06 R-03: 422 entries are normalised to {path, code, sum} whether the server names them path or field', async () => {
    const problem = await failure(
      422,
      problemBody(422, 'flag_definition_invalid', { errors: [{ path: 'rules[0].rollout', code: 'weights_sum_invalid', sum: 9000 }, { field: 'owner', code: 'owner_missing' }, { nope: 1 }] }),
    );
    expect(problem?.fieldErrors).toEqual([
      { path: 'rules[0].rollout', code: 'weights_sum_invalid', sum: 9000 },
      { path: 'owner', code: 'owner_missing' },
    ]);
  });

  it('W06 AS-50: Retry-After becomes retryAfterSeconds', async () => {
    expect(await failure(429, problemBody(429, 'rate_limited'), { 'Retry-After': '12' })).toMatchObject({ status: 429, retryAfterSeconds: 12 });
  });

  it('W06 AS-38: currentStatus is read for an invalid transition', async () => {
    expect((await failure(409, problemBody(409, 'invalid_transition', { currentStatus: 'killed' })))?.currentStatus).toBe('killed');
  });

  it('W06 AS-51: a body that is not problem+json is a status-only problem', async () => {
    server.use(http.get(`${FLAGS_URL}/new-checkout`, () => new HttpResponse('<html>bad gateway</html>', { status: 502 })));
    const problem = await getFlag('new-checkout').catch((error: unknown) => readFlagProblem(error));
    expect(problem).toEqual({ status: 502, fieldErrors: [] });
  });

  it('W06 AS-27: a request that got no answer is status 0', async () => {
    server.use(http.get(`${FLAGS_URL}/new-checkout`, () => HttpResponse.error()));
    const problem = await getFlag('new-checkout').catch((error: unknown) => readFlagProblem(error));
    expect(problem).toEqual({ status: 0, fieldErrors: [] });
  });
});
