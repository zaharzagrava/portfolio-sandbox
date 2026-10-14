import { beforeEach, describe, expect, it, vi } from 'vitest';

const files = vi.hoisted(() => ({ content: '(()=>{})();' as string | null }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  const readFile = vi.fn(async () => {
    if (files.content === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return Buffer.from(files.content);
  });
  return { ...original, default: { ...original, readFile }, readFile };
});

import { GET } from './route';

beforeEach(() => {
  files.content = '(()=>{})();';
});

describe('W07 widget bundle route (AS-39)', () => {
  it('W07 AS-39: serves the script with the headers another origin needs to load it', async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/javascript/);
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(response.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.text()).toBe('(()=>{})();');
  });

  it('W07 AS-39: a missing build is a 503 that is never cached as the script', async () => {
    files.content = null;
    const response = await GET();
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).not.toMatch(/javascript/);
  });
});
