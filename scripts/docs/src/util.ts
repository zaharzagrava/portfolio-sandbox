import { createHash } from 'node:crypto';

export const sha = (s: string, len = 16): string => createHash('sha256').update(s).digest('hex').slice(0, len);

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, sortKeys(x)]),
    );
  }
  return v;
}

/** JSON with recursively sorted keys: stable hashes and stable git diffs. */
export const stableStringify = (v: unknown, indent?: number): string => JSON.stringify(sortKeys(v), null, indent);

export const hashOf = (v: unknown): string => sha(stableStringify(v));

export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function makeMatcher(globs: string[]): (path: string) => boolean {
  const res = globs.map(globToRegExp);
  return (p) => res.some((r) => r.test(p));
}

export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

export const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'x';

export const posix = (p: string): string => p.split('\\').join('/');

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Strips // and block comments and trailing commas so tsconfig.json (JSONC) can be JSON.parsed. */
export function parseJsonc(text: string): any {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      i = i < 0 ? text.length : i + 2;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

export const mdCell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();
export const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
export const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];
export const bySort = <T>(xs: T[], key: (x: T) => string): T[] => [...xs].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
