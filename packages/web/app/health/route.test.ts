import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';

afterEach(() => vi.restoreAllMocks());

describe('W07 liveness route (AS-41)', () => {
  it('W07 AS-41: answers 200 {"status":"ok"} with Cache-Control no-store', async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('W07 AS-41: makes no outbound call (the probe must not depend on the backend)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await GET();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
