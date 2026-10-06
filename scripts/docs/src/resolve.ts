import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix as pp } from 'node:path';
import { parseJsonc } from './util.ts';

interface PathsConfig { baseDir: string; paths: [string, string[]][] }

const EXTS = ['.ts', '.tsx', '.js', '.mjs', '.cjs'];

/** Resolves import specifiers to repo-relative file paths using relative paths + the nearest tsconfig `paths`. */
export class Resolver {
  private readonly root: string;
  private readonly files: Set<string>;
  private readonly cfgCache = new Map<string, PathsConfig | null>();

  constructor(root: string, files: Set<string>) {
    this.root = root;
    this.files = files;
  }

  private loadTsconfig(dir: string, depth = 0): PathsConfig | null {
    const file = join(this.root, dir, 'tsconfig.json');
    if (!existsSync(file) || depth > 4) return null;
    try {
      const json = parseJsonc(readFileSync(file, 'utf8'));
      const co = json.compilerOptions ?? {};
      let inherited: PathsConfig | null = null;
      if (typeof json.extends === 'string' && json.extends.startsWith('.')) {
        const extDir = pp.dirname(pp.join(dir, json.extends));
        inherited = this.loadTsconfig(extDir === '.' ? '' : extDir, depth + 1);
      }
      const baseDir = co.baseUrl ? pp.normalize(pp.join(dir, co.baseUrl)) : (inherited?.baseDir ?? dir);
      const paths = co.paths ? (Object.entries(co.paths) as [string, string[]][]) : (inherited?.paths ?? []);
      return { baseDir: baseDir === '.' ? '' : baseDir, paths: paths.map(([k, v]) => [k, v.map((t) => (co.paths ? pp.join(dir, co.baseUrl ?? '.', t) : t))]) };
    } catch {
      return null;
    }
  }

  private nearestConfig(fromDir: string): PathsConfig | null {
    let dir = fromDir === '.' ? '' : fromDir;
    for (;;) {
      if (!this.cfgCache.has(dir)) this.cfgCache.set(dir, this.loadTsconfig(dir));
      const c = this.cfgCache.get(dir);
      if (c) return c;
      if (!dir) return null;
      dir = pp.dirname(dir) === '.' ? '' : pp.dirname(dir);
    }
  }

  private tryFile(base: string): string | null {
    const b = pp.normalize(base);
    const stripped = b.replace(/\.(m|c)?js$/, '');
    for (const cand of [b, ...EXTS.map((e) => b + e), ...EXTS.map((e) => stripped + e), ...EXTS.map((e) => `${b}/index${e}`)]) {
      if (this.files.has(cand)) return cand;
    }
    return null;
  }

  resolve(fromFile: string, spec: string): string | null {
    const fromDir = pp.dirname(fromFile);
    if (spec.startsWith('.')) return this.tryFile(pp.join(fromDir, spec));
    const cfg = this.nearestConfig(fromDir);
    if (!cfg) return null;
    for (const [pattern, targets] of cfg.paths) {
      const star = pattern.indexOf('*');
      let rest: string | null = null;
      if (star < 0) rest = pattern === spec ? '' : null;
      else {
        const pre = pattern.slice(0, star);
        const post = pattern.slice(star + 1);
        if (spec.startsWith(pre) && spec.endsWith(post) && spec.length >= pre.length + post.length) rest = spec.slice(pre.length, spec.length - post.length);
      }
      if (rest === null) continue;
      for (const t of targets) {
        const hit = this.tryFile(star < 0 ? t : t.replace('*', rest));
        if (hit) return hit;
      }
    }
    return null;
  }
}

export const dirOf = dirname;
