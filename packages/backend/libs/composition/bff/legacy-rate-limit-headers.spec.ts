import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * The legacy `RateLimit-Limit|Remaining|Reset` and `X-RateLimit-*` headers no longer exist (S50). Clients read the
 * structured `RateLimit` and `RateLimit-Policy` (S48 follow-up for S42, S43, S48). The names are assembled from
 * fragments so this file does not match its own search.
 */
const LEGACY = new RegExp(
  ['RateLimit-' + '(Limit|Remaining|Reset)', 'X-' + 'RateLimit-'].join('|'),
  'i',
);

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === '.next') return [];
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

const SELF = __filename;
const roots = [
  join(__dirname),
  join(__dirname, '..', '..', '..', '..', 'web', 'lib'),
];

describe('S48 legacy rate-limit headers are gone from the BFF and its web clients', () => {
  it.each(
    roots.map((root) => [
      relative(join(__dirname, '..', '..', '..', '..'), root),
      root,
    ]),
  )('S48 S50-follow-up: %s names no legacy header', (_label, root) => {
    const offenders = walk(root)
      .filter((f) => /\.(ts|tsx)$/.test(f) && f !== SELF)
      .filter((f) => LEGACY.test(readFileSync(f, 'utf8')))
      .map((f) => relative(root, f));
    expect(offenders).toEqual([]);
  });
});
