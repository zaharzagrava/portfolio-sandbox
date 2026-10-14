import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const isSource = (file: string) => /\.(ts|tsx)$/.test(file) && !/\.(test|spec)\.(ts|tsx)$/.test(file);

/** The files the shell owns (W07): the frame, system states, legal and docs pages, security modules and providers. */
function shellFiles(): string[] {
  const pick = (dir: string) => walk(join(root, dir)).filter(isSource);
  const single = ['app/layout.tsx', 'app/not-found.tsx', 'app/error.tsx', 'app/global-error.tsx', 'app/loading.tsx', 'app/robots.ts', 'proxy.ts', 'lib/providers.tsx', 'lib/query-client.ts', 'lib/browser-storage-keys.ts']
    .map((file) => join(root, file))
    .filter((file) => {
      try {
        statSync(file);
        return true;
      } catch {
        return false;
      }
    });
  const dirs = ['components/layout', 'components/analytics', 'components/legal', 'components/widget', 'lib/security', 'lib/routes', 'lib/widget', 'app/privacy', 'app/terms', 'app/developers/docs', 'app/health']
    .filter((dir) => {
      try {
        return statSync(join(root, dir)).isDirectory();
      } catch {
        return false;
      }
    })
    .flatMap(pick);
  return [...new Set([...single, ...dirs])];
}

/** Source without comments (a `//` after a colon is part of a URL, not a comment). */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const rel = (file: string) => relative(root, file).split(sep).join('/');

function offenders(pattern: RegExp, allowed: (file: string, line: string) => boolean = () => false): string[] {
  const found: string[] = [];
  for (const file of shellFiles()) {
    code(file)
      .split('\n')
      .forEach((line, index) => {
        if (pattern.test(line) && !allowed(rel(file), line)) found.push(`${rel(file)}:${index + 1}: ${line.trim()}`);
      });
  }
  return found;
}

describe('W07 shell boundaries (AS-37, FR-025)', () => {
  it('W07 AS-37: the scan sees the shell (it is not an empty glob)', () => {
    const files = shellFiles().map(rel);
    expect(files).toEqual(expect.arrayContaining(['app/layout.tsx', 'components/layout/navbar.tsx', 'lib/security/csp.ts', 'proxy.ts']));
  });

  it('W07 AS-37: no absolute API address and no NEXT_PUBLIC_ API variable in shell code', () => {
    expect(offenders(/https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/)).toEqual([]);
    expect(offenders(/NEXT_PUBLIC_(API|BFF|SSE|BACKEND)/)).toEqual([]);
    expect(offenders(/process\.env\.API_URL/, (file) => file === 'proxy.ts')).toEqual([]);
  });

  it('W07 AS-37: no browser storage or cookie writes except the theme key', () => {
    expect(offenders(/localStorage\.(setItem|removeItem|clear)|sessionStorage\.(setItem|removeItem|clear)/, (file) => file === 'components/layout/theme-control.tsx')).toEqual([]);
    expect(offenders(/document\.cookie\s*=[^=]/)).toEqual([]);
  });

  it('W07 AS-37: no token held by the shell', () => {
    expect(offenders(/\b(accessToken|refreshToken|access_token|refresh_token)\b/)).toEqual([]);
  });

  it('W07 FR-025: no raw HTML, eval, Function constructor or string timer in shell code', () => {
    expect(offenders(/dangerouslySetInnerHTML/)).toEqual([]);
    expect(offenders(/\beval\s*\(/)).toEqual([]);
    expect(offenders(/new\s+Function\s*\(/)).toEqual([]);
    expect(offenders(/\b(setTimeout|setInterval)\s*\(\s*['"`]/)).toEqual([]);
  });
});
