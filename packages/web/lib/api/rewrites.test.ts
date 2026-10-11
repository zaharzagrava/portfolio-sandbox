import { describe, expect, it } from 'vitest';
import nextConfig from '../../next.config';

/**
 * `__Host-` cookies are only valid when the API and the web app share one origin (S02 follow-up, S48 FR-040): the web
 * app must proxy the BFF's paths itself instead of calling another host from the browser.
 */
describe('S48 same-origin routing of the BFF', () => {
  it('S48 AS-43: /api/graphql and /api/bff/* are rewritten to the BFF, ahead of the catch-all', async () => {
    const rewrites = (await nextConfig.rewrites!()) as { source: string; destination: string }[];
    const index = (source: string) => rewrites.findIndex((r) => r.source === source);
    const graphql = index('/api/graphql');
    const bff = index('/api/bff/:path*');
    const catchAll = index('/api/:path*');
    expect(graphql).toBeGreaterThanOrEqual(0);
    expect(bff).toBeGreaterThanOrEqual(0);
    expect(catchAll).toBeGreaterThan(Math.max(graphql, bff));
    expect(new URL(rewrites[graphql].destination).origin).toBe(
      new URL(rewrites[bff].destination.replace(':path*', 'x')).origin,
    );
    expect(rewrites[graphql].destination.endsWith('/api/graphql')).toBe(true);
    expect(rewrites[bff].destination.endsWith('/api/bff/:path*')).toBe(true);
  });

  it('W01 A7: every other /api path (REST and streams) goes through the BFF forwarder, never straight to a service', async () => {
    const rewrites = (await nextConfig.rewrites!()) as { source: string; destination: string }[];
    const catchAll = rewrites.find((r) => r.source === '/api/:path*')!;
    const bffOrigin = new URL(rewrites[0].destination).origin;
    expect(catchAll.destination).toBe(`${bffOrigin}/api/bff/f/:path*`);
    expect(rewrites.filter((r) => !r.destination.startsWith(`${bffOrigin}/`))).toEqual([]);
  });
});
