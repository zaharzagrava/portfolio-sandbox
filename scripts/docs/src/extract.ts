import { extname } from 'node:path';
import type { DocsConfig } from './config.ts';
import { sha, uniq } from './util.ts';

export interface ExportInfo { name: string; kind: string; line: number }
export interface ImportInfo { spec: string; kind: 'import' | 'reexport' | 'dynamic' | 'require'; typeOnly: boolean }
export interface RouteInfo { kind: 'http' | 'graphql' | 'message'; method: string; path: string; handler: string; line: number }
export interface EventDef { const: string; name: string; aggregate: string; line: number }
export interface JobHandlerInfo { name: string; handler: string; line: number }
export interface ScheduleInfo { job: string; cron: string }

export interface FileFacts {
  path: string;
  language: 'ts' | 'js' | 'rust' | 'go' | 'python';
  hash: string;
  lines: number;
  chars: number;
  imports: ImportInfo[];
  exports: ExportInfo[];
  routes: RouteInfo[];
  eventDefs: EventDef[];
  /** `X.create(` call targets (candidate event producers). */
  createCalls: string[];
  /** `X.match(` / `X.topic` references (candidate event consumers). */
  matchCalls: string[];
  jobHandlers: JobHandlerInfo[];
  jobsEnqueued: string[];
  schedules: ScheduleInfo[];
  /** Only re-exports: nothing worth sending to an LLM. */
  isBarrel: boolean;
  /** Barrel or a handful of lines: summarised deterministically. */
  isTrivial: boolean;
}

/** Blanks out comments (keeping newlines so line numbers survive) while leaving string contents alone. */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') {
        out += ' ';
        i++;
      }
    } else if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      for (; i < stop; i++) out += src[i] === '\n' ? '\n' : ' ';
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j++;
        else if (c !== '`' && src[j] === '\n') break;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const DEC_ARGS = '(?:\\((?:[^()]|\\((?:[^()]|\\([^()]*\\))*\\))*\\))?';
const AFTER_DECORATORS = `\\s*(?:@\\w+${DEC_ARGS}\\s*)*(?:(?:public|private|protected|static|readonly)\\s+)*(?:async\\s+)?([A-Za-z_$][\\w$]*)\\s*[(<]`;

function lineIndex(text: string): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

const joinPath = (a: string, b: string) => `/${[a, b].map((s) => s.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')}`;

function extractTs(path: string, text: string, cfg: DocsConfig): Omit<FileFacts, 'path' | 'language' | 'hash' | 'lines' | 'chars'> {
  const code = stripComments(text);
  const lineOf = lineIndex(code);
  const imports: ImportInfo[] = [];
  let m: RegExpExecArray | null;

  const importRe = /(?:^|[\n;])\s*import\s+(type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
  while ((m = importRe.exec(code))) imports.push({ spec: m[2], kind: 'import', typeOnly: !!m[1] });
  const reexportRe = /(?:^|[\n;])\s*export\s+(type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s+['"]([^'"]+)['"]/g;
  while ((m = reexportRe.exec(code))) imports.push({ spec: m[2], kind: 'reexport', typeOnly: !!m[1] });
  const dynRe = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dynRe.exec(code))) imports.push({ spec: m[1], kind: 'dynamic', typeOnly: false });
  const reqRe = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = reqRe.exec(code))) imports.push({ spec: m[1], kind: 'require', typeOnly: false });

  const exports: ExportInfo[] = [];
  const expRe = /^export\s+(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(async\s+function\*?|function\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
  while ((m = expRe.exec(code))) exports.push({ name: m[2], kind: m[1].replace(/^async\s+/, ''), line: lineOf(m.index) });
  const expListRe = /^export\s*\{([^}]*)\}(?!\s*from)/gm;
  while ((m = expListRe.exec(code))) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) exports.push({ name, kind: 'reexport', line: lineOf(m.index) });
    }
  }

  const routes: RouteInfo[] = [];
  const controllers: { index: number; prefix: string }[] = [];
  const ctrlRe = /@Controller\(\s*(?:['"`]([^'"`]*)['"`]|\{[^}]*?path:\s*['"`]([^'"`]*)['"`][^}]*\})?[^)]*\)/g;
  while ((m = ctrlRe.exec(code))) controllers.push({ index: m.index, prefix: m[1] ?? m[2] ?? '' });
  const prefixAt = (idx: number) => [...controllers].reverse().find((c) => c.index < idx)?.prefix ?? '';
  const httpRe = new RegExp(`@(Get|Post|Put|Patch|Delete|Head|Options|All)\\(\\s*(?:['"\`]([^'"\`]*)['"\`])?[^)]*\\)${AFTER_DECORATORS}`, 'g');
  while ((m = httpRe.exec(code))) {
    routes.push({ kind: 'http', method: m[1].toUpperCase(), path: joinPath(prefixAt(m.index), m[2] ?? ''), handler: m[3], line: lineOf(m.index) });
  }
  const gqlRe = new RegExp(`@(Query|Mutation|Subscription)\\(${DEC_ARGS}${AFTER_DECORATORS}`, 'g');
  while ((m = gqlRe.exec(code))) routes.push({ kind: 'graphql', method: m[1].toUpperCase(), path: m[2], handler: m[2], line: lineOf(m.index) });
  const msgRe = new RegExp(`@(EventPattern|MessagePattern)\\(\\s*['"\`]([^'"\`]+)['"\`][^)]*\\)${AFTER_DECORATORS}`, 'g');
  while ((m = msgRe.exec(code))) routes.push({ kind: 'message', method: m[1] === 'EventPattern' ? 'EVENT' : 'MESSAGE', path: m[2], handler: m[3], line: lineOf(m.index) });

  const definer = cfg.conventions.eventDefiner;
  const eventDefs: EventDef[] = [];
  const evRe = new RegExp(`(?:export\\s+)?const\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${definer}\\(\\s*['"\`]([^'"\`]+)['"\`]\\s*,\\s*['"\`]([^'"\`]+)['"\`]`, 'g');
  while ((m = evRe.exec(code))) eventDefs.push({ const: m[1], name: m[2], aggregate: m[3], line: lineOf(m.index) });

  const createCalls: string[] = [];
  const createRe = /\b([A-Za-z_$][\w$]*)\.create\(/g;
  while ((m = createRe.exec(code))) createCalls.push(m[1]);
  const matchCalls: string[] = [];
  const matchRe = /\b([A-Za-z_$][\w$]*)\.(?:match\(|topic\b)/g;
  while ((m = matchRe.exec(code))) matchCalls.push(m[1]);

  const jobHandlers: JobHandlerInfo[] = [];
  const jhRe = new RegExp(`@${cfg.conventions.jobHandlerDecorator}\\(\\s*['"\`]([^'"\`]+)['"\`][^)]*\\)${AFTER_DECORATORS}`, 'g');
  while ((m = jhRe.exec(code))) jobHandlers.push({ name: m[1], handler: m[2], line: lineOf(m.index) });
  const jobsEnqueued: string[] = [];
  const enqRe = new RegExp(`\\.${cfg.conventions.enqueueMethod}\\(\\s*['"\`]([\\w.:\\-]+)['"\`]`, 'g');
  while ((m = enqRe.exec(code))) jobsEnqueued.push(m[1]);
  const schedules: ScheduleInfo[] = [];
  const schedRe = new RegExp(`${cfg.conventions.scheduleMethod}\\(\\s*\\{([^}]*)\\}`, 'g');
  while ((m = schedRe.exec(code))) {
    const job = /jobType:\s*['"`]([^'"`]+)['"`]/.exec(m[1])?.[1];
    const cron = /cron:\s*['"`]([^'"`]+)['"`]/.exec(m[1])?.[1];
    if (job) schedules.push({ job, cron: cron ?? '?' });
  }

  const nonBlank = code.split('\n').filter((l) => l.trim());
  const withoutReexports = code.replace(reexportRe, '').replace(/^\s*import\s[^;]*?['"][^'"]+['"];?/gm, '').replace(/[;\s]/g, '');
  const isBarrel = reexports(imports) > 0 && withoutReexports === '';
  // A tiny file with no exports is usually side-effect setup (instrument.ts): worth an LLM look.
  const isTrivial = isBarrel || (nonBlank.length <= 5 && code.length < 400 && exports.length > 0);

  return {
    imports,
    exports: dedupeExports(exports),
    routes,
    eventDefs,
    createCalls: uniq(createCalls),
    matchCalls: uniq(matchCalls),
    jobHandlers,
    jobsEnqueued: uniq(jobsEnqueued),
    schedules,
    isBarrel,
    isTrivial,
  };
}

const reexports = (imports: ImportInfo[]) => imports.filter((i) => i.kind === 'reexport').length;
const dedupeExports = (xs: ExportInfo[]) => {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(x.name) ? false : (seen.add(x.name), true)));
};

function extractOther(language: FileFacts['language'], text: string): Pick<FileFacts, 'exports' | 'imports'> {
  const lineOf = lineIndex(text);
  const exports: ExportInfo[] = [];
  const patterns: Record<string, RegExp> = {
    rust: /^\s*pub(?:\([^)]*\))?\s+(?:async\s+)?(fn|struct|enum|trait|type|const|mod)\s+([A-Za-z_]\w*)/gm,
    go: /^(?:func\s+(?:\([^)]*\)\s*)?|type\s+|var\s+|const\s+)([A-Z]\w*)/gm,
    python: /^(?:async\s+)?(def|class)\s+([A-Za-z]\w*)/gm,
  };
  const re = patterns[language];
  let m: RegExpExecArray | null;
  if (re) {
    while ((m = re.exec(text))) {
      const name = m[2] ?? m[1];
      exports.push({ name, kind: m[2] ? m[1] : 'decl', line: lineOf(m.index) });
    }
  }
  return { exports: dedupeExports(exports), imports: [] };
}

const LANG: Record<string, FileFacts['language']> = { '.ts': 'ts', '.tsx': 'ts', '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.rs': 'rust', '.go': 'go', '.py': 'python' };

export function extractFile(path: string, text: string, cfg: DocsConfig): FileFacts {
  const language = LANG[extname(path)] ?? 'ts';
  const base = { path, language, hash: sha(text, 20), lines: text.split('\n').length, chars: text.length };
  if (language === 'ts' || language === 'js') return { ...base, ...extractTs(path, text, cfg) };
  const { exports, imports } = extractOther(language, text);
  const nonBlank = text.split('\n').filter((l) => l.trim()).length;
  return {
    ...base,
    imports,
    exports,
    routes: [],
    eventDefs: [],
    createCalls: [],
    matchCalls: [],
    jobHandlers: [],
    jobsEnqueued: [],
    schedules: [],
    isBarrel: false,
    isTrivial: nonBlank <= 5 && exports.length > 0,
  };
}
