// @vitest-environment node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Static rules over the source (the shared architecture test of the web capabilities, test-plan "Static gates"). This part
 * is W04's (AS-92, AS-93; constitution VI.2, VI.3, VI.4, VI.6): the file sets below name what the seller dashboard owns;
 * files that do not exist yet are simply absent, so the rules tighten as the stories land.
 */

const root = path.resolve(__dirname, '..');
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
const under = (...dirs: string[]) => dirs.flatMap((dir) => walk(path.join(root, dir))).filter(isSource);
const named = (...files: string[]) => files.map((file) => path.join(root, file)).filter((file) => existsSync(file));

// --- the W04 file sets -------------------------------------------------------------------------------------------------
/** Components, pages and layouts of the seller dashboard and the invitation page: render and react, never touch the network. */
const renderFiles = under('components/seller', 'components/dashboard', 'app/dashboard', 'app/invites').filter((file) => !/\/actions\.ts$/.test(rel(file)));
/** Libraries and server modules of the seller dashboard. */
const libFiles = [
  ...under('lib/seller'),
  ...walk(path.join(root, 'lib/api')).filter((file) => /\/seller[^/]*\.ts$/.test(file) && isSource(file)),
  ...named('lib/server/seller.server.ts'),
];
const w04 = [...new Set([...renderFiles, ...libFiles])];

describe('W04 architecture rules', () => {
  it('W04 AS-92: the file sets are not empty', () => {
    expect(renderFiles.length).toBeGreaterThan(10);
    expect(libFiles.length).toBeGreaterThan(5);
  });

  it('W04 AS-92: no fetch, axios or EventSource in components, hooks, pages or layouts', () => {
    const offenders = renderFiles.filter((file) => /\bfetch\s*\(|from ['"]axios['"]|\bapiClient\b|\bEventSource\b|fetch-event-source/.test(code(file)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('W04 AS-92: query keys come only from lib/query-keys.ts (no literal queryKey arrays)', () => {
    const offenders = w04.filter((file) => /\bqueryKey\s*:\s*\[|\bqueryKey\s*=\s*\[/.test(code(file)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('W04 AS-92: no new Context and no global store', () => {
    const offenders = w04.filter((file) => /\bcreateContext\s*\(|from ['"](?:zustand|jotai|redux|@reduxjs\/toolkit|valtio)/.test(code(file)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('W04 AS-92: no "use cache" in a W04 file (per-member data is never shared)', () => {
    const offenders = w04.filter((file) => /^\s*['"]use cache(?::\s*\w+)?['"]/m.test(read(file)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('W04 AS-92: no seller page keeps the blanket instant opt-out under a shop (Suspense replaces it)', () => {
    const offenders = under('app/dashboard/seller/[shopId]').filter((file) => /export\s+const\s+instant\s*=\s*false/.test(code(file)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('W04 AS-92: no array index as a React key (placeholder skeletons are decorative and exempt)', () => {
    const indexKey = /\bkey=\{\s*(?:i|idx|index|\w*Index)\s*\}|\bkey=\{`[^`]*\$\{\s*(?:i|idx|index|\w*Index)\s*\}/;
    expect(w04.filter((file) => !/skeleton/i.test(rel(file)) && indexKey.test(code(file))).map(rel)).toEqual([]);
  });

  it('W04 AS-93: no token, no Authorization header, no readable cookie, no credential in browser storage', () => {
    const offenders = w04.filter((file) =>
      /\bAuthorization\b|\bBearer\b|\bsetAccessToken\b|\brefreshSession\s*\(|\{[^}]*\brefreshSession\b[^}]*\}\s*from|document\.cookie|\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b/.test(code(file)),
    );
    expect(offenders.map(rel)).toEqual([]);
  });

  it('W04 AS-93: URLs are relative and same-origin (no absolute literal, no NEXT_PUBLIC_API_URL)', () => {
    // A placeholder or a link in a component may name an absolute URL; a request never does (libraries and server modules).
    const offenders = w04.filter((file) => (libFiles.includes(file) && /['"`]https?:\/\//.test(code(file))) || /NEXT_PUBLIC_API_URL|NEXT_PUBLIC_SSE_URL/.test(code(file)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('W04 AS-94: no window.confirm and no dangerouslySetInnerHTML', () => {
    const offenders = w04.filter((file) => /\b(?:window|globalThis)\.confirm\b|(?:\bif\s*\(|!|&&|\|\|)\s*confirm\s*\(|dangerouslySetInnerHTML/.test(code(file)));
    expect(offenders.map(rel)).toEqual([]);
  });
});

// --- the W05 file sets (chat and assistant) ----------------------------------------------------------------------------
/** Components, pages and hooks of the product chat and the assistant sheet: render and react, never touch the network. */
const w05RenderFiles = [
  ...under('components/chat', 'components/assistant', 'app/chat'),
  ...named('hooks/use-assistant-chat.ts', 'hooks/use-chat-live.ts', 'hooks/use-read-tracker.ts', 'hooks/use-presence.ts', 'hooks/use-jittered-backoff.ts'),
];
/** Libraries of the two features: the API clients, the stream reader and the pure logic. */
const w05LibFiles = [
  ...under('lib/chat', 'lib/assistant'),
  ...named('lib/api/chat.ts', 'lib/api/assistant.ts', 'lib/api/sse-reader.ts', 'lib/realtime/chat-topics.ts'),
];
const w05 = [...new Set([...w05RenderFiles, ...w05LibFiles])];
/** The one module that may touch `sessionStorage` (FR-071). */
const ACTIVE_STORE = 'lib/assistant/active-store.ts';

describe('W05 architecture rules', () => {
  it('W05 AS-67: the library file set holds the modules of the two features', () => {
    for (const file of ['lib/chat/links.ts', 'lib/chat/catch-up.ts', 'lib/chat/pending-messages.ts', 'lib/assistant/reply-reducer.ts', ACTIVE_STORE, 'lib/api/chat.ts', 'lib/api/assistant.ts']) {
      expect(w05LibFiles.map(rel), file).toContain(file);
    }
  });

  it('W05 AS-67: no fetch, axios or EventSource in components, hooks, pages or layouts of the chat and the assistant', () => {
    const offenders = w05RenderFiles.filter((file) => /\bfetch\s*\(|from ['"]axios['"]|\bapiClient\b|\bEventSource\b|fetch-event-source|\bstreamSse\b/.test(code(file)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('W05 AS-68: query keys come only from lib/query-keys.ts (no literal queryKey arrays)', () => {
    const offenders = w05.filter((file) => /\bqueryKey\s*:\s*\[|\bqueryKey\s*=\s*\[/.test(code(file)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('W05 AS-68: no new Context and no global store', () => {
    const offenders = w05.filter((file) => /\bcreateContext\s*\(|from ['"](?:zustand|jotai|redux|@reduxjs\/toolkit|valtio)/.test(code(file)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('W05 AS-67: nothing is stored in the browser except the assistant pointer, and only lib/assistant/active-store.ts touches storage', () => {
    const offenders = w05.filter((file) => rel(file) !== ACTIVE_STORE && /\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|document\.cookie|\bcaches\.open\b/.test(code(file)));
    expect(offenders.map(rel)).toEqual([]);
    const store = path.join(root, ACTIVE_STORE);
    expect(existsSync(store), `${ACTIVE_STORE} exists`).toBe(true);
    expect(code(store)).not.toMatch(/\blocalStorage\b|\bindexedDB\b|document\.cookie/);
  });

  it('W05 AS-67: no token, no Authorization header, no refresh from a W05 file', () => {
    const offenders = w05.filter((file) => /\bAuthorization\b|\bBearer\b|\bsetAccessToken\b|\bgetAccessToken\b|\brefreshSession\s*\(|\{[^}]*\brefreshSession\b[^}]*\}\s*from/.test(code(file)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('W05 AS-67: URLs are relative and same-origin (no absolute literal in a library, no NEXT_PUBLIC_API_URL or NEXT_PUBLIC_SSE_URL)', () => {
    const offenders = w05.filter((file) => (w05LibFiles.includes(file) && /['"`]https?:\/\//.test(code(file))) || /NEXT_PUBLIC_API_URL|NEXT_PUBLIC_SSE_URL/.test(code(file)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('W05 AS-67: no dangerouslySetInnerHTML (message and answer text is rendered as text)', () => {
    expect(w05.filter((file) => /dangerouslySetInnerHTML/.test(code(file))).map(rel)).toEqual([]);
  });

  it('W05 AS-68: no array index as a React key (placeholder skeletons are decorative and exempt)', () => {
    const indexKey = /\bkey=\{\s*(?:i|idx|index|\w*Index)\s*\}|\bkey=\{`[^`]*\$\{\s*(?:i|idx|index|\w*Index)\s*\}|\bm\.id\s*\|\|\s*i\b/;
    expect(w05.filter((file) => !/skeleton/i.test(rel(file)) && indexKey.test(code(file))).map(rel)).toEqual([]);
  });

  it('W05 AS-69: app/chat/page.tsx is a Server Component that reads the request inside <Suspense>', () => {
    const file = path.join(root, 'app/chat/page.tsx');
    expect(existsSync(file)).toBe(true);
    const source = code(file);
    expect(source).not.toMatch(/^\s*['"]use client['"]/m);
    expect(source).toMatch(/<Suspense\b/);
    expect(source).toMatch(/\brequireServerSession\s*\(/);
    expect(source).toMatch(/\bsearchParams\b/);
    // The page function itself only renders the shell and the boundary: awaiting the session or the search params happens in a child inside <Suspense>.
    const page = source.slice(source.search(/export\s+default\s+(?:async\s+)?function/));
    const body = page.slice(0, page.search(/\n}\n|\n}$/) + 2);
    expect(body).not.toMatch(/\bawait\b|\bcookies\s*\(|\bheaders\s*\(/);
    expect(body).not.toMatch(/export\s+default\s+async/);
  });

  it('W05 AS-69: no "use cache" in app/chat or in any W05 file (member data is private and per user)', () => {
    const offenders = w05.filter((file) => /^\s*['"]use cache(?::\s*\w+)?['"]/m.test(read(file)));
    expect(offenders.map(rel)).toEqual([]);
  });
});

// --- the W06 file sets (admin feature-flag console) --------------------------------------------------------------------
/** Pages, layouts, components and the hook of the admin console: render and react, never touch the network. */
const w06RenderFiles = [...under('app/admin', 'components/admin'), ...named('hooks/use-admin-flags.ts')];
/** The console's libraries: the API clients and the pure logic. */
const w06LibFiles = [...under('lib/admin'), ...named('lib/api/admin-flags.ts', 'lib/api/admin-flags.server.ts')];
const w06 = [...new Set([...w06RenderFiles, ...w06LibFiles])];

describe('W06 architecture rules', () => {
  it('W06 AS-55: the file sets hold the console', () => {
    for (const file of ['app/admin/layout.tsx', 'app/admin/feature-flags/page.tsx', 'components/admin/flags/flag-editor.tsx', 'hooks/use-admin-flags.ts']) expect(w06RenderFiles.map(rel), file).toContain(file);
    for (const file of ['lib/api/admin-flags.ts', 'lib/api/admin-flags.server.ts', 'lib/admin/flags/draft.ts']) expect(w06LibFiles.map(rel), file).toContain(file);
  });

  it('W06 AS-55: no fetch, axios or EventSource in components, hooks, pages or layouts', () => {
    const offenders = w06RenderFiles.filter((file) => /\bfetch\s*\(|from ['"]axios['"]|\bapiClient\b|\bEventSource\b|fetch-event-source/.test(code(file)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('W06 AS-55: query keys come only from lib/query-keys.ts (no literal queryKey arrays)', () => {
    expect(w06.filter((file) => /\bqueryKey\s*:\s*\[|\bqueryKey\s*=\s*\[|\bmutationKey\s*:\s*\[/.test(code(file))).map(rel)).toEqual([]);
  });

  it('W06 AS-55: no new Context and no global store', () => {
    expect(w06.filter((file) => /\bcreateContext\s*\(|from ['"](?:zustand|jotai|redux|@reduxjs\/toolkit|valtio)/.test(code(file))).map(rel)).toEqual([]);
  });

  it('W06 AS-55: no "use cache" and no instant opt-out under app/admin (per-user pages; Suspense replaces it)', () => {
    expect(w06.filter((file) => /^\s*['"]use cache(?::\s*\w+)?['"]/m.test(read(file))).map(rel)).toEqual([]);
    expect(under('app/admin').filter((file) => /export\s+const\s+instant\s*=\s*false/.test(code(file))).map(rel)).toEqual([]);
  });

  it('W06 AS-55: no array index as a React key (placeholder skeletons are decorative and exempt)', () => {
    const indexKey = /\bkey=\{\s*(?:i|idx|index|\w*Index)\s*\}|\bkey=\{`[^`]*\$\{\s*(?:i|idx|index|\w*Index)\s*\}/;
    expect(w06.filter((file) => !/skeleton/i.test(rel(file)) && indexKey.test(code(file))).map(rel)).toEqual([]);
  });

  it('W06 AS-56: no token, no Authorization header, no readable cookie, nothing in browser storage', () => {
    const offenders = w06.filter((file) =>
      /\bAuthorization\b|\bBearer\b|\bsetAccessToken\b|\bgetAccessToken\b|\brefreshSession\s*\(|\{[^}]*\brefreshSession\b[^}]*\}\s*from|document\.cookie|\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b/.test(code(file)),
    );
    expect(offenders.map(rel)).toEqual([]);
  });

  it('W06 AS-56: URLs are relative and same-origin (no absolute literal in a library, no NEXT_PUBLIC_API_URL)', () => {
    const offenders = w06.filter((file) => (w06LibFiles.includes(file) && /['"`]https?:\/\//.test(code(file))) || /NEXT_PUBLIC_API_URL|NEXT_PUBLIC_SSE_URL/.test(code(file)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('W06 AS-56: requests go only to /api/admin/flags (client) or its BFF forwarder path (server)', () => {
    const paths = [...code(path.join(root, 'lib/api/admin-flags.ts')).matchAll(/['"`](\/api\/[^'"`]*)['"`]/g)].map((match) => match[1]!);
    expect(paths.length).toBeGreaterThan(0);
    for (const url of paths) expect(url, url).toMatch(/^\/api\/admin\/flags/);
    for (const match of code(path.join(root, 'lib/api/admin-flags.server.ts')).matchAll(/['"`](\/api\/[^'"`]*)['"`]/g)) expect(match[1]).toMatch(/^\/api\/bff\/f\/admin\/flags/);
  });

  it('W06 AS-56: no flag body goes to console.* and no dangerouslySetInnerHTML or window.confirm', () => {
    expect(w06.filter((file) => /\bconsole\.\w+\s*\(/.test(code(file))).map(rel)).toEqual([]);
    expect(w06.filter((file) => /dangerouslySetInnerHTML|\b(?:window|globalThis)\.confirm\b|(?:\bif\s*\(|!|&&|\|\|)\s*confirm\s*\(/.test(code(file))).map(rel)).toEqual([]);
  });

  it('W06 AS-55: the old draft console is gone (no adminApi, booleanFlag, flag-row test id or feature-flags-client)', () => {
    expect(existsSync(path.join(root, 'lib/api/admin.ts'))).toBe(false);
    expect(existsSync(path.join(root, 'app/admin/feature-flags/feature-flags-client.tsx'))).toBe(false);
    expect(w06.filter((file) => /\badminApi\b|\bbooleanFlag\b|data-testid=["']flag-row["']/.test(code(file))).map(rel)).toEqual([]);
  });

  it('W06 FR-002: every admin page is a Server Component that reads the request inside <Suspense>', () => {
    for (const file of ['app/admin/layout.tsx', 'app/admin/feature-flags/page.tsx', 'app/admin/feature-flags/new/page.tsx', 'app/admin/feature-flags/[key]/page.tsx']) {
      const source = code(path.join(root, file));
      expect(source, file).not.toMatch(/^\s*['"]use client['"]/m);
      expect(source, file).toMatch(/<Suspense\b/);
      const page = source.slice(source.search(/export\s+default\s+(?:async\s+)?function/));
      expect(page.slice(0, page.search(/\n}\n|\n}$/) + 2), file).not.toMatch(/\bawait\b|\bcookies\s*\(|\bheaders\s*\(|export\s+default\s+async/);
    }
  });

  it('W06 AS-48: no flag data request before the guard (every page calls requireAdminPage first)', () => {
    for (const file of ['app/admin/feature-flags/page.tsx', 'app/admin/feature-flags/new/page.tsx', 'app/admin/feature-flags/[key]/page.tsx']) {
      const source = code(path.join(root, file));
      const guard = source.search(/\brequireAdminPage\s*\(/);
      expect(guard, file).toBeGreaterThan(-1);
      for (const read of source.matchAll(/\b(?:getFlagPage|getFlagServer|getHistoryPage|getStale)\s*\(/g)) expect(read.index!, file).toBeGreaterThan(guard);
    }
  });
});
