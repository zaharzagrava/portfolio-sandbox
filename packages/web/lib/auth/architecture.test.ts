// @vitest-environment node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const rel = (file: string) => path.relative(root, file);

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

const source = (file: string) => file.endsWith('.ts') || file.endsWith('.tsx');
const isTest = (file: string) => /\.test\.tsx?$/.test(file);
const read = (file: string) => readFileSync(file, 'utf8');
const hasDirective = (code: string, directive: string) => new RegExp(`^\\s*(?:/\\*[\\s\\S]*?\\*/\\s*|//[^\\n]*\\n\\s*)*['"]${directive}['"]`).test(code);

const w01Dirs = ['app/(auth)', 'app/account', 'components/auth', 'hooks', 'lib/auth'].map((dir) => path.join(root, dir));
const w01Files = w01Dirs.flatMap((dir) => walk(dir)).filter((file) => source(file) && !isTest(file));
const appFiles = walk(path.join(root, 'app')).filter(source);

describe('W01 architecture rules', () => {
  it('W01 AS-63: every page.tsx and layout.tsx under (auth) and account is a Server Component', () => {
    // Pages of deferred stories (P2/P3) that still are the old client pages; the pass that builds them removes the entry.
    const deferred = ['app/(auth)/forgot-password/page.tsx'];
    const entries = [...walk(path.join(root, 'app/(auth)')), ...walk(path.join(root, 'app/account'))].filter(
      (file) => /(?:^|\/)(?:page|layout)\.tsx$/.test(file) && !deferred.includes(rel(file)),
    );
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.filter((file) => hasDirective(read(file), 'use client')).map(rel)).toEqual([]);
  });

  it('W01 AS-62: no layout reads the session at its top level; the session reader sits in components under Suspense', () => {
    const layouts = appFiles.filter((file) => /(?:^|\/)layout\.tsx$/.test(file));
    const readers = layouts.filter((file) => /@\/lib\/auth\/session\.server|getServerSession|requireServerSession/.test(read(file)));
    expect(readers.map(rel)).toEqual([]);
  });

  it('W01 AS-62: no "use cache" module imports the session reader', () => {
    const files = [...appFiles, ...walk(path.join(root, 'components')), ...walk(path.join(root, 'lib'))].filter(
      (file) => source(file) && !isTest(file),
    );
    const cached = files.filter((file) => hasDirective(read(file), 'use cache') || /^\s*['"]use cache(?::\s*\w+)?['"]/m.test(read(file)));
    expect(cached.filter((file) => /session\.server|getServerSession|requireServerSession/.test(read(file))).map(rel)).toEqual([]);
  });

  it('W01 AS-65: no proxy.ts or middleware.ts makes an authorization decision', () => {
    for (const name of ['proxy.ts', 'middleware.ts']) {
      const file = path.join(root, name);
      if (!existsSync(file)) continue;
      expect(read(file), name).not.toMatch(/session\.server|getServerSession|requireServerSession|BFF_COOKIES|__Host-bff|\/login|loginHref/);
    }
  });

  it('W01 FR-002: only lib/api makes network calls in the auth and account code', () => {
    const offenders = w01Files.filter((file) => /\bfetch\(|from ['"]axios['"]|new EventSource\(|new WebSocket\(/.test(read(file)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('W01 AS-29: no token storage, Authorization header or NEXT_PUBLIC base URL in the browser code', () => {
    const files = [...w01Files, ...walk(path.join(root, 'lib/api')).filter((file) => source(file) && !isTest(file))];
    const offenders = files.filter((file) => /localStorage|sessionStorage|indexedDB|\bAuthorization\b|NEXT_PUBLIC_API_URL|setAccessToken|getAccessToken/.test(read(file)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('W01 AS-63: client components in the auth and account folders are leaves (they import no server-only module)', () => {
    const clients = w01Files.filter((file) => hasDirective(read(file), 'use client'));
    expect(clients.filter((file) => /server-only|session\.server|next\/headers/.test(read(file))).map(rel)).toEqual([]);
  });
});
