import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const DOMAIN = __dirname;
const BACKEND = join(__dirname, '..', '..', '..');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

/** Source files of the domain (no specs): what the boundary rules apply to. */
const sources = walk(DOMAIN).filter(
  (f) => f.endsWith('.ts') && !/\.(e2e-)?spec\.ts$/.test(f),
);
const text = (file: string) => readFileSync(file, 'utf8');
const matching = (pattern: RegExp, files = sources) =>
  files.filter((f) => pattern.test(text(f))).map((f) => relative(DOMAIN, f));

describe('Payments: domain boundaries', () => {
  it('S13 AS-64: the entry point exports neither the payment model, its status, the DTO service and module, nor the ledger and payout models and the balance projector', () => {
    const barrel = text(join(DOMAIN, 'index.ts'));
    for (const name of [
      'PaymentModel',
      'PaymentStatus',
      'PaymentDtoService',
      'PaymentDtoModule',
      'BalanceProjector',
      'LedgerEntryModel',
      'PayoutModel',
    ])
      expect(barrel).not.toMatch(new RegExp(`\\b${name}\\b`));
  });

  it('S13 AS-64: the payment model has no association or foreign key to orders, users or the ledger', () => {
    const model = text(join(DOMAIN, 'infra/models/payment.model.ts'));
    expect(model).not.toMatch(/@(BelongsTo|HasMany|HasOne|ForeignKey)\b/);
    expect(model).not.toMatch(/@app\/domains\/(orders|identity)/);
    const ledger = text(join(DOMAIN, 'infra/models/ledger-entry.model.ts'));
    expect(ledger).not.toMatch(/@(BelongsTo|ForeignKey)\b/);
    expect(ledger).not.toMatch(/\bPayment\b.*from '\.\/payment\.model'/);
  });

  it('S13 AS-64: payments imports nothing from the orders domain (no orders <-> payments cycle)', () => {
    expect(matching(/@app\/domains\/orders/)).toEqual([]);
  });

  it('S13 AS-64: payments reads no table of the catalog (no Product SQL, no stock update)', () => {
    expect(matching(/\b(FROM|UPDATE|JOIN|INTO)\s+"?Product"?\b/i)).toEqual([]);
    expect(matching(/SET\s+"?quantity"?\s*=/i)).toEqual([]);
  });

  it('S13 AS-64: no legacy messaging in payments: no KafkaTopicGroup.payments, OutboxService.notify or KafkaConsumerService.consume', () => {
    expect(matching(/KafkaTopicGroup\.payments/)).toEqual([]);
    expect(matching(/\.notify\(/)).toEqual([]);
    expect(matching(/KafkaConsumerService/)).toEqual([]);
  });

  it('S13 AS-64: the count of direct sequelize.transaction sites in payments did not rise (4, all in the ledger, payout and reconciliation code of S14 and S15)', () => {
    const sites = matching(/\bsequelize\.transaction\(/);
    expect(sites.sort()).toEqual([
      'infra/payout.jobs.ts',
      'infra/reconciliation.jobs.ts',
    ]);
    const count = sources
      .map((f) => (text(f).match(/\bsequelize\.transaction\(/g) ?? []).length)
      .reduce((a, b) => a + b, 0);
    expect(count).toBe(4);
  });

  it('S13 AS-64: the table-ownership findings left for payments are the three in S14 and S15 files', () => {
    const out = execFileSync('pnpm', ['check:table-ownership'], {
      cwd: BACKEND,
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    const section = out.split(/\n(?=\S)/).find((s) => s.startsWith('payments'));
    const files = (section ?? '')
      .split('\n')
      .slice(1)
      .map((l) => l.trim().split(/\s+/).pop())
      .filter(Boolean)
      .sort();
    expect(files).toEqual([
      'libs/domains/payments/finance-worker.module.ts',
      'libs/domains/payments/infra/models/ledger-entry.model.ts',
      'libs/domains/payments/infra/payout.jobs.ts',
    ]);
  });
});
