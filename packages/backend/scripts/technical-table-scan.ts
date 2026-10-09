/**
 * Technical tables (owner `infrastructure:*`: Outbox, ProcessedWebhookEvent, IdempotencyKey, Job…) are reachable only
 * through their owning lib's exported services (constitution IX.4/IX.6, S53 AS-09, SC-008). This scan lists every
 * place outside the owning lib that names such a table in SQL or imports its model.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ownerOf } from '../db/ownership';

const BACKEND = join(__dirname, '..');

/**
 * Known violations that belong to other specs; the gate is green with exactly these and fails on any other
 * reference. An entry that no longer matches is reported as stale, so the list shrinks as the owners fix them.
 */
export const HANDED_OVER: Record<string, string> = {
  'libs/domains/media/infra/media-processor.ts':
    'S29 (media): append the event through OutboxService.appendWithExecutor',
  'libs/domains/catalog-sync/application/catalog-import.service.ts':
    'S07 (catalog sync): use OutboxService.append',
  'libs/domains/orders/api/stripe-webhook.controller.ts':
    'S10 (orders): use InboxService.claim',
};

export interface TableReference {
  file: string;
  table: string;
  kind: 'sql' | 'model';
}

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === 'node_modules') return [];
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

const isTest = (file: string): boolean =>
  /\.(e2e-)?spec\.ts$/.test(file) ||
  file.includes('/testing/') ||
  file.includes('/test/');

/** `libs/infrastructure/<name>/` for owner `infrastructure:<name>`; owners without such a lib have no allowed place. */
const owningLib = (owner: string): string =>
  `libs/infrastructure/${owner.slice('infrastructure:'.length)}/`;

export function scanTechnicalTables(
  roots: string[] = ['libs', 'apps'],
): TableReference[] {
  const found: TableReference[] = [];
  for (const root of roots) {
    for (const abs of walk(join(BACKEND, root)).filter(
      (f) => f.endsWith('.ts') && !isTest(f),
    )) {
      const file = relative(BACKEND, abs);
      const src = readFileSync(abs, 'utf8');
      for (const [, table] of src.matchAll(/"([A-Z][A-Za-z_]+)"/g)) {
        const owner = ownerOf(table);
        if (
          owner?.startsWith('infrastructure:') &&
          !file.startsWith(owningLib(owner))
        )
          found.push({ file, table, kind: 'sql' });
      }
      // The model classes of the inbox and the outbox are not exported to anybody else.
      for (const [, module] of src.matchAll(
        /from\s+'([^']*\/(?:outbox|inbox)\.model)'/g,
      )) {
        const lib = module.includes('outbox')
          ? 'libs/infrastructure/outbox/'
          : 'libs/infrastructure/inbox/';
        if (!file.startsWith(lib))
          found.push({ file, table: module, kind: 'model' });
      }
    }
  }
  const seen = new Set<string>();
  return found.filter((r) => {
    const key = `${r.file}|${r.table}|${r.kind}`;
    return !seen.has(key) && seen.add(key);
  });
}

/** What fails the gate: references that are not handed over, and handed-over files that no longer reference anything. */
export function technicalTableViolations(
  refs: TableReference[] = scanTechnicalTables(),
): {
  unexpected: TableReference[];
  stale: string[];
} {
  const files = new Set(refs.map((r) => r.file));
  return {
    unexpected: refs.filter((r) => !(r.file in HANDED_OVER)),
    stale: Object.keys(HANDED_OVER).filter((f) => !files.has(f)),
  };
}
