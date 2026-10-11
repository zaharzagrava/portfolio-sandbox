// @vitest-environment node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * U-arch (W02 AS-69..AS-72, AS-76; gaps A8, G11): static rules over the storefront source. The rules apply to the W02
 * files; the `PENDING` allowlists name old files that a later W02 task rebuilds, and each task removes its entry.
 */

const root = path.resolve(__dirname, '../..');
const rel = (file: string) => path.relative(root, file).split(path.sep).join('/');

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === 'node_modules' || name.startsWith('.')) continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const isSource = (file: string) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file);
const read = (file: string) => readFileSync(file, 'utf8');
/** Source without comments, so a rule is not tripped by prose that names a forbidden call. */
const code = (file: string) => read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
const isClient = (file: string) => /^\s*(?:(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*)\s*)*['"]use client['"]/.test(read(file));
const usesCache = (file: string) => /^\s*['"]use cache(?::\s*\w+)?['"]/m.test(read(file));

const under = (...dirs: string[]) => dirs.flatMap((dir) => walk(path.join(root, dir))).filter((file) => isSource(file) && !isPending(file));
/** Like `under`, but also the pending files: rules that must hold everywhere use this. */
const everywhere = (...dirs: string[]) => dirs.flatMap((dir) => walk(path.join(root, dir))).filter(isSource);
const named = (...files: string[]) => files.map((file) => path.join(root, file)).filter((file) => existsSync(file) && !isPending(file));

/** Pages that still hold the old direct reads; the task named in the comment rebuilds each and deletes its entry. */
const PENDING_PAGES: string[] = [];
/** Old components replaced by the story that owns them (T087 discussions, T092 ask). */
const PENDING_COMPONENTS = ['components/product/product-discussions.tsx', 'components/product/ask-product.tsx'];

const isPending = (file: string) => [...PENDING_PAGES, ...PENDING_COMPONENTS].includes(rel(file));

// --- the W02 file sets ------------------------------------------------------------------------------------------------
/** Files that render: no network, no Authorization, no storage. */
const renderFiles = [
  ...under('components/search', 'components/product', 'components/home', 'components/analytics'),
  ...named('components/product-card.tsx'),
  ...walk(path.join(root, 'hooks')).filter((file) => isSource(file) && !/hooks\/use-(auth|assistant|event)/.test(rel(file))),
];
/** Pages and layouts of the storefront routes. */
const pageFiles = [
  ...named('app/page.tsx'),
  ...under('app/search', 'app/products', 'app/p').filter((file) => /(?:^|\/)(?:page|layout)\.tsx$/.test(rel(file))),
];
const libFiles = [
  ...under('lib/search', 'lib/product', 'lib/home', 'lib/pickup', 'lib/analytics', 'lib/attribution', 'lib/seo', 'lib/server', 'lib/storefront'),
  ...named(
    'lib/api/search.ts',
    'lib/api/suggest.ts',
    'lib/api/pickup.ts',
    'lib/api/discussions.ts',
    'lib/api/ask.ts',
    'lib/api/share.ts',
    'lib/api/videos.ts',
    'lib/api/ads.ts',
    'lib/api/events.ts',
    'lib/api/idempotency.ts',
    'lib/api/problem-copy.ts',
    'lib/routes.ts',
    'lib/safe-html.ts',
    'lib/safe-url.ts',
  ),
];
const routeHandlers = under('app/api/attribution');
const w02 = [...new Set([...renderFiles, ...pageFiles, ...libFiles, ...routeHandlers])];

describe('W02 architecture rules', () => {
  it('W02 AS-70: no fetch, axios or EventSource in components, hooks, pages or layouts', () => {
    const files = [...renderFiles, ...pageFiles];
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((file) => /\bfetch\s*\(|from ['"]axios['"]|\bnew EventSource\s*\(|\bEventSource\b/.test(code(file)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('W02 AS-70: no NEXT_PUBLIC_API_URL anywhere in the app', () => {
    const files = under('app', 'components', 'hooks', 'lib');
    expect(files.filter((file) => /NEXT_PUBLIC_API_URL/.test(code(file))).map(rel)).toEqual([]);
  });

  it('W02 FR-152: API_URL, BFF_URL and SITE_URL are read only in lib/server/*.server.ts (which import server-only)', () => {
    const readers = everywhere('app', 'components', 'hooks', 'lib').filter((file) => {
      const name = rel(file);
      if (name.startsWith('lib/server/') || name === 'lib/config.ts' || name === 'lib/config-parse.ts') return false;
      return /\bconfig\.(?:apiUrl|bffUrl|siteUrl|sseUrl|publicApiUrl)\b|process\.env\.(?:API_URL|BFF_URL|SITE_URL|SSE_URL|PUBLIC_API_URL)\b|\bserverApiUrl\b/.test(code(file));
    });
    expect(readers.map(rel)).toEqual([]);
    const serverModules = under('lib/server');
    expect(serverModules.filter((file) => !/\.server\.ts$/.test(file)).map(rel)).toEqual([]);
    expect(serverModules.filter((file) => !/^\s*import ['"]server-only['"]/m.test(read(file))).map(rel)).toEqual([]);
  });

  it('W02 AS-70: no Authorization header and no web storage in the W02 files', () => {
    const offenders = w02
      .filter((file) => /\bAuthorization\b|\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b/.test(code(file)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('W02 AS-70: only the analytics id helper reads document.cookie among the W02 files', () => {
    const offenders = w02.filter((file) => rel(file) !== 'lib/analytics/track.ts' && /document\.cookie/.test(code(file)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('W02 AS-70: every storefront page and layout is a Server Component', () => {
    // (empty until T033/T045/T059 rebuild the pages; PENDING_PAGES holds the old ones)
    expect(pageFiles.filter(isClient).map(rel)).toEqual([]);
  });

  it('W02 AS-70: client files are leaves: they import no server-only module', () => {
    const clients = w02.filter(isClient);
    const offenders = clients.filter((file) => /server-only|\.server['"]|next\/headers/.test(code(file)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('W02 AS-70: props that a Server Component passes to a client file are plain fields (no function types)', () => {
    const serverFiles = w02.filter((file) => !isClient(file) && /\.tsx$/.test(file));
    const clientByModule = new Map(
      w02
        .filter((file) => isClient(file) && /\.tsx$/.test(file))
        .map((file) => [`@/${rel(file).replace(/\.tsx$/, '')}`, file] as const),
    );
    const imported = new Set<string>();
    for (const file of serverFiles) {
      for (const [specifier, client] of clientByModule) if (code(file).includes(`'${specifier}'`)) imported.add(rel(client));
    }
    const offenders = [...imported].filter((client) => {
      const source = code(path.join(root, client));
      const props = [...source.matchAll(/(?:type|interface)\s+\w*Props\b[^=]*?[={]([\s\S]*?)\n\}|type\s+\w*Props\s*=\s*([^;]*);/g)];
      return props.some((match) => /=>|\bFunction\b/.test(match[1] ?? match[2] ?? ''));
    });
    expect(offenders).toEqual([]);
  });

  it('W02 AS-72: dangerouslySetInnerHTML only renders sanitizer output or escaped JSON-LD', () => {
    const offenders = w02
      .filter((file) => /dangerouslySetInnerHTML/.test(code(file)))
      .filter((file) => !/sanitizeBodyHtml\(|application\/ld\+json/.test(code(file)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('W02 AS-76: no array index as a React key', () => {
    const indexKey = /\bkey=\{\s*(?:i|idx|index|\w*Index)\s*\}|\bkey=\{`[^`]*\$\{\s*(?:i|idx|index|\w*Index)\s*\}/;
    expect(w02.filter((file) => indexKey.test(code(file))).map(rel)).toEqual([]);
  });

  it('W02 AS-71: no new Context and no global store in the W02 files', () => {
    const offenders = w02.filter((file) => /\bcreateContext\s*\(|from ['"](?:zustand|jotai|redux|@reduxjs\/toolkit|valtio)/.test(code(file)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('W02 AS-69: no "use cache" function reads cookies, headers or the session', () => {
    const files = [...under('app', 'components', 'lib')].filter(usesCache);
    const offenders = files.filter((file) => /next\/headers|\bcookies\s*\(|\bheaders\s*\(|session\.server|getServerSession|requireServerSession/.test(code(file)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('W02 gaps G11: sanitizeBodyHtml is not imported from a Server Component', () => {
    const importers = under('app', 'components', 'hooks', 'lib').filter(
      (file) => rel(file) !== 'lib/safe-html.ts' && /from ['"]@\/lib\/safe-html['"]|from ['"](?:\.\.?\/)+safe-html['"]/.test(code(file)),
    );
    expect(importers.filter((file) => !isClient(file)).map(rel)).toEqual([]);
  });
});
