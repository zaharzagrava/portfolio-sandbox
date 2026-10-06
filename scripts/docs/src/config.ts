import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseJsonc } from './util.ts';

/** file -> module (static) -> capmap (one per unit: its top-level topics) -> concept (one page per topic; a page names its parts and the ones that are not self-explanatory become pages of their own, recursively) -> unit -> flow -> system. */
export type Level = 'file' | 'module' | 'capmap' | 'concept' | 'unit' | 'flow' | 'system' | 'theory';
export const LEVELS: Level[] = ['file', 'module', 'capmap', 'concept', 'unit', 'flow', 'system', 'theory'];

export interface UnitRule {
  /** Path pattern relative to the repo root; `*` matches exactly one segment. The matched prefix is the unit root. */
  match: string;
  group: string;
  /** How many directory levels below the unit root form a "module" (default 1). */
  moduleDepth?: number;
}

export interface DocsConfig {
  outDir: string;
  sourceExtensions: string[];
  ignore: string[];
  units: UnitRule[];
  models: Record<Level, string> & { leaf: string };
  maxFileChars: number;
  /** Source characters sent with one concept prompt (split across its files). */
  maxConceptChars: number;
  /** How many times a topic may be split into sub-topics (0 = only the top-level topics from the capability map). */
  maxConceptDepth: number;
  /** Hard cap on topics per unit, so a runaway split cannot burn the budget. */
  maxConceptsPerUnit: number;
  /** Hand-written theory notes whose sections get "In this codebase" links. */
  theory: { dir: string; exclude: string[]; patternMap: string; conceptsPerSection: number; filesPerSection: number };
  /** Import-derived "built on" candidates kept per concept (the model then picks the ones that matter). */
  maxConceptUses: number;
  maxFlowEdges: number;
  contextFiles: string[];
  contextSnippetChars: number;
  conventions: {
    eventDefiner: string;
    jobHandlerDecorator: string;
    enqueueMethod: string;
    scheduleMethod: string;
  };
  diagram: { maxUnitEdges: number };
}

export const DEFAULT_CONFIG: DocsConfig = {
  outDir: 'docs/humans',
  sourceExtensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.rs', '.go', '.py'],
  ignore: ['**/node_modules/**', '**/*.d.ts', '**/*.spec.ts', '**/*.test.ts', '**/*.spec.tsx', '**/*.test.tsx', '**/dist/**', '**/.next/**'],
  units: [{ match: '*/*', group: 'package' }],
  models: {
    file: 'claude-haiku-4-5-20251001',
    module: 'claude-haiku-4-5-20251001',
    capmap: 'claude-sonnet-5-5',
    concept: 'claude-sonnet-5-5',
    leaf: 'claude-haiku-4-5-20251001',
    unit: 'claude-sonnet-5-5',
    flow: 'claude-sonnet-5-5',
    system: 'claude-sonnet-5-5',
    theory: 'claude-sonnet-5-5',
  },
  theory: { dir: 'interview-prep', exclude: ['my-practice', 'README.md'], patternMap: 'docs/architecture/pattern-map.md', conceptsPerSection: 6, filesPerSection: 6 },
  maxFileChars: 24000,
  maxConceptChars: 36000,
  maxConceptUses: 8,
  maxConceptDepth: 4,
  maxConceptsPerUnit: 40,
  maxFlowEdges: 30,
  contextFiles: [],
  contextSnippetChars: 2500,
  conventions: {
    eventDefiner: 'defineEvent',
    jobHandlerDecorator: 'JobHandler',
    enqueueMethod: 'enqueue',
    scheduleMethod: 'upsertSchedule',
  },
  diagram: { maxUnitEdges: 60 },
};

export function loadConfig(root: string, path?: string): DocsConfig {
  const file = path ?? join(root, 'scripts/docs/docs.config.json');
  if (!existsSync(file)) return DEFAULT_CONFIG;
  const user = parseJsonc(readFileSync(file, 'utf8'));
  return {
    ...DEFAULT_CONFIG,
    ...user,
    models: { ...DEFAULT_CONFIG.models, ...(user.models ?? {}) },
    conventions: { ...DEFAULT_CONFIG.conventions, ...(user.conventions ?? {}) },
    diagram: { ...DEFAULT_CONFIG.diagram, ...(user.diagram ?? {}) },
    theory: { ...DEFAULT_CONFIG.theory, ...(user.theory ?? {}) },
  };
}
