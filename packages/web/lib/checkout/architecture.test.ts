// @vitest-environment node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * UA (W03 AS-70, AS-71, AS-72; gaps A9, T8): static rules over the W03 source. The file sets below name what W03 owns;
 * files that do not exist yet are simply absent, so the rules tighten as the stories land. Old stand-ins that W03 replaces
 * are in the sets on purpose: until T082/T084 remove or rewrite them this test is red, and that is the signal.
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

const under = (...dirs: string[]) => dirs.flatMap((dir) => walk(path.join(root, dir))).filter(isSource);
const named = (...files: string[]) => files.map((file) => path.join(root, file)).filter((file) => existsSync(file));

// --- the W03 file sets -------------------------------------------------------------------------------------------------
/** Components and hooks: render and react, never touch the network. */
const renderFiles = [
  ...under('components/cart', 'components/checkout', 'components/orders', 'components/notifications'),
  ...named(
    'components/add-to-cart-button.tsx',
    'hooks/use-user-stream.ts',
    'hooks/use-online.ts',
    'hooks/use-pay-flow.ts',
  ),
];
/** Pages, layouts and route files of the W03 routes. */
const pageFiles = under('app/cart', 'app/checkout', 'app/orders');
const routePages = pageFiles.filter((file) => /(?:^|\/)page\.tsx$/.test(rel(file)));
/** Libraries and server modules. */
const libFiles = [
  ...under('lib/checkout', 'lib/cart', 'lib/orders', 'lib/realtime'),
  ...named(
    'lib/api/cart.ts',
    'lib/api/checkout.ts',
    'lib/api/orders.ts',
    'lib/api/payments.ts',
    'lib/api/notifications.ts',
    'lib/safe-link.ts',
    'lib/server/checkout.server.ts',
    'lib/server/orders.server.ts',
    'lib/server/payments.server.ts',
  ),
];
const w03 = [...new Set([...renderFiles, ...pageFiles, ...libFiles])];

const ATTEMPT_STORE = 'lib/checkout/attempt-store.ts';
/** The storage object used (`sessionStorage.x`, `sessionStorage[`, passed or returned), not a label like `'sessionStorage'` or `sessionStorage:`. */
const USES_SESSION_STORAGE = /\bsessionStorage\s*[.[;,)]/;

describe('W03 architecture rules', () => {
  it('W03 AS-71: no fetch, axios or EventSource in components, hooks, pages or layouts', () => {
    const files = [...renderFiles, ...pageFiles].filter((file) => rel(file) !== 'app/checkout/actions.ts');
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((file) => /\bfetch\s*\(|from ['"]axios['"]|\bapiClient\b|\bEventSource\b|fetch-event-source/.test(code(file)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('W03 AS-71: query keys come only from lib/query-keys.ts (no literal queryKey arrays)', () => {
    const offenders = w03.filter((file) => /\bqueryKey\s*:\s*\[|\bsetQueryDefaults\s*\(/.test(code(file)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('W03 AS-71: no new Context and no global store', () => {
    const offenders = w03.filter((file) => /\bcreateContext\s*\(|from ['"](?:zustand|jotai|redux|@reduxjs\/toolkit|valtio)/.test(code(file)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('W03 AS-70: no "use cache" in a W03 file', () => {
    const offenders = w03.filter((file) => /^\s*['"]use cache(?::\s*\w+)?['"]/m.test(read(file)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('W03 AS-70: the /cart page reads nothing at request time and is not a Client Component', () => {
    const cart = named('app/cart/page.tsx');
    expect(cart.length).toBe(1);
    const source = code(cart[0]);
    expect(isClient(cart[0])).toBe(false);
    expect(source).not.toMatch(/next\/headers|\bcookies\s*\(|\bheaders\s*\(|\bparams\b|\bsearchParams\b|requireServerSession|getServerSession|\bconnection\s*\(/);
  });

  it('W03 AS-70: a guarded page reads the request inside <Suspense>, never in a blocking async page', () => {
    const guarded = routePages.filter((file) => rel(file) !== 'app/cart/page.tsx' && /\bparams\b|\bsearchParams\b|requireServerSession|getServerSession|\bcookies\s*\(/.test(code(file)));
    const offenders = guarded.filter((file) => {
      const source = code(file);
      return /export\s+default\s+async\s+function/.test(source) || !/<Suspense\b/.test(source);
    });
    expect(offenders.map(rel)).toEqual([]);
  });

  it('W03 AS-72: no token, no Authorization header, no readable cookie, no storage outside the attempt store', () => {
    const offenders = w03.filter((file) => {
      const source = code(file);
      if (/\bAuthorization\b|\bBearer\b|\bsetAccessToken\b|\brefreshSession\b|document\.cookie|\blocalStorage\b|\bindexedDB\b/.test(source)) return true;
      return rel(file) !== ATTEMPT_STORE && USES_SESSION_STORAGE.test(source);
    });
    expect(offenders.map(rel)).toEqual([]);
  });

  it('W03 AS-72: the attempt store is the only sessionStorage user of W03 and lives outside lib/api (W05 adds exactly one more, its assistant pointer, FR-071)', () => {
    expect(named(ATTEMPT_STORE).length, `${ATTEMPT_STORE} must exist`).toBe(1);
    const users = under('app', 'components', 'hooks', 'lib').filter((file) => USES_SESSION_STORAGE.test(code(file)) && !/^lib\/(?:auth|api)\//.test(rel(file)));
    expect(users.map(rel).sort()).toEqual(['lib/assistant/active-store.ts', ATTEMPT_STORE]);
  });

  it('W03 AS-72: URLs are relative and same-origin (no absolute literal, no NEXT_PUBLIC_API_URL)', () => {
    const offenders = w03.filter((file) => /['"`]https?:\/\//.test(code(file)) || /NEXT_PUBLIC_API_URL|NEXT_PUBLIC_SSE_URL/.test(code(file)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('W03 AS-72: server modules import server-only; client files import no server-only module', () => {
    const servers = w03.filter((file) => /\.server\.ts$/.test(file));
    expect(servers.filter((file) => !/^\s*import ['"]server-only['"]/m.test(read(file))).map(rel)).toEqual([]);
    const clients = w03.filter(isClient);
    expect(clients.filter((file) => /server-only|\.server['"]|next\/headers/.test(code(file))).map(rel)).toEqual([]);
  });

  it('W03 FR-056: no array index as a React key', () => {
    const indexKey = /\bkey=\{\s*(?:i|idx|index|\w*Index)\s*\}|\bkey=\{`[^`]*\$\{\s*(?:i|idx|index|\w*Index)\s*\}/;
    expect(w03.filter((file) => indexKey.test(code(file))).map(rel)).toEqual([]);
  });

  it('W03 AS-73: no dangerouslySetInnerHTML and no data-testid', () => {
    expect(w03.filter((file) => /dangerouslySetInnerHTML|data-testid/.test(code(file))).map(rel)).toEqual([]);
  });

  it('W03 AS-73: money is never divided, rounded or parsed as a float in W03 files', () => {
    const offenders = w03.filter((file) => /\/\s*100\b|\.toFixed\s*\(|\bparseFloat\s*\(|\bMath\.round\s*\(/.test(code(file)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('W03 plan Phase 8: no import of a removed name or of the old ProductCard props', () => {
    const removed =
      /\bCART_QUERY_KEY\b|\bORDERS_QUERY_KEY\b|\bcartApi\b|\bcartTotals\b|\bnextQuantity\b|\buseCart\b|\buseSetCartQuantity\b|lib\/api\/sse|use-event-stream|\buseEventStream\b|\bcreateEventStream\b|NEXT_PUBLIC_SSE_URL|import\s*\{[^}]*\b(?:PaymentStatus|Order)\b[^}]*\}\s*from\s*['"]@\/lib\/types['"]|@\/components\/product-card['"]/;
    // The stand-in badge and navbar files are W07 files that T042 updates; they are checked through their W03 import below.
    const offenders = [...w03, ...named('components/layout/navbar.tsx', 'components/layout/mobile-menu.tsx')].filter((file) => removed.test(code(file)));
    expect(offenders.map(rel)).toEqual([]);
  });
});
