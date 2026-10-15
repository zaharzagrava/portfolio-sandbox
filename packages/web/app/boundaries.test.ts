import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const USE_CLIENT = /^\s*(['"])use client\1/;

const exists = (file: string) => {
  try {
    return statSync(join(root, file)).isFile();
  } catch {
    return false;
  }
};
const isClient = (file: string) => USE_CLIENT.test(readFileSync(join(root, file), 'utf8'));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(root, dir))) {
    const path = `${dir}/${entry}`;
    if (statSync(join(root, path)).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

const isDir = (dir: string) => {
  try {
    return statSync(join(root, dir)).isDirectory();
  } catch {
    return false;
  }
};

const sources = (dir: string) => (isDir(dir) ? walk(dir) : []).filter((file) => /\.(ts|tsx)$/.test(file) && !/\.(test|spec)\./.test(file));

/** Every client file the shell may contain, with the reason it needs the browser (AS-38). */
const CLIENT_LEAVES: Record<string, string> = {
  'components/layout/mobile-menu.tsx': 'open state, focus return',
  'components/layout/theme-control.tsx': 'theme menu',
  'components/layout/search-row.tsx': 'open state, focus',
  'components/layout/offline-notice.tsx': 'online/offline events',
  'components/layout/route-focus.tsx': 'focus after navigation',
  'components/layout/main-nav.tsx': 'active link (aria-current)',
  'components/layout/member-only.tsx': 'renders only for a signed-in member',
  'components/layout/slot-boundary.tsx': 'error boundary for one header slot',
  'components/layout/route-error.tsx': 'error boundary body',
  'components/layout/system-states.tsx': 'ErrorState: focus, retry timer',
  'components/analytics/page-view.tsx': 'usePathname + track',
  'components/analytics/product-view.tsx': 'effect + track (W02 AS-67)',
  'components/analytics/ref-capture.tsx': 'useSearchParams + same-origin POST (W02 AS-63)',
  'components/legal/on-this-page.tsx': 'moves focus to the heading of the chosen section',
  'components/widget/checkout-app.tsx': 'postMessage, state',
  'app/error.tsx': 'error boundary',
  'app/global-error.tsx': 'error boundary',
  'app/developers/docs/reference.tsx': 'expand/collapse, copy',
  'lib/providers.tsx': 'providers',
};

describe('W07 server components first (AS-38)', () => {
  it.each(['app/layout.tsx', 'components/layout/footer.tsx', 'components/layout/navbar.tsx', 'components/layout/skip-link.tsx', 'components/layout/nonce-providers.tsx', 'app/not-found.tsx', 'app/loading.tsx'])(
    'W07 AS-38: %s is a Server Component',
    (file) => {
      expect(exists(file), `${file} exists`).toBe(true);
      expect(isClient(file)).toBe(false);
    },
  );

  it.each(['app/privacy/page.tsx', 'app/terms/page.tsx', 'app/developers/docs/page.tsx', 'components/legal/legal-page.tsx'])('W07 AS-38: legal and docs pages: %s is a Server Component', (file) => {
    expect(exists(file), `${file} exists`).toBe(true);
    expect(isClient(file)).toBe(false);
  });

  it('W07 AS-38: "use client" appears only on the listed leaves', () => {
    const shell = [
      ...sources('components/layout'),
      ...sources('components/analytics'),
      ...sources('components/legal'),
      ...(exists('components/widget/checkout-app.tsx') ? sources('components/widget') : []),
      ...sources('app/privacy'),
      ...sources('app/terms'),
      ...sources('app/developers/docs'),
      'app/layout.tsx',
      'app/error.tsx',
      'app/global-error.tsx',
      'app/not-found.tsx',
      'app/loading.tsx',
      'lib/providers.tsx',
    ].filter(exists);
    const unlisted = shell.filter((file) => isClient(file) && !(file in CLIENT_LEAVES));
    expect(unlisted).toEqual([]);
  });

  it('W07 AS-38: every listed leaf still exists and still needs the browser (a stale entry fails)', () => {
    const stale = Object.keys(CLIENT_LEAVES).filter((file) => !exists(file) || !isClient(file));
    expect(stale).toEqual([]);
  });

  it('W07 AS-38: the shell uses no array index as a key', () => {
    const offenders: string[] = [];
    for (const file of [...sources('components/layout'), ...sources('app/privacy'), ...sources('app/terms'), ...sources('app/developers/docs'), ...sources('components/legal')]) {
      readFileSync(join(root, file), 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (/key=\{(index|i|idx)\}|key=\{`[^`]*\$\{(index|i|idx)\}/.test(line)) offenders.push(`${relative(root, join(root, file)).split(sep).join('/')}:${index + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
