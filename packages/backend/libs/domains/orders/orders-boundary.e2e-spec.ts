import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { getOptions } from 'sequelize-typescript';
import { ownedBy } from '../../../db/ownership';
import { ORDER_MODELS } from './orders-models';

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

/** The names a barrel line exports, e.g. `export { default as FooModel } from …` → `FooModel`. */
const exportedNames = (code: string): string[] =>
  [...code.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)].flatMap((m) =>
    m[1]
      .split(',')
      .map((s) =>
        s
          .trim()
          .split(/\s+as\s+/)
          .pop()!,
      )
      .filter(Boolean),
  );

/** The transitional exports may only shrink: add a name here only with a dated reason in plan.md (CT-1). */
const TRANSITIONAL_ALLOWED = [
  'BisOrderItemModel',
  'BisOrderModel',
  'BisOrderScope',
  'BisOrderWithAllFilters',
  'ShopOrderModel',
  'StockReservationModel',
  'CheckoutDiscounts',
  'DiscountableLine',
  'ORDER_MODELS',
  'CreateBisOrderDto',
  'OrderService',
];

describe('Orders: domain boundaries', () => {
  const barrel = text(join(DOMAIN, 'index.ts'));
  const marker = barrel.indexOf('TRANSITIONAL');
  const stable = barrel.slice(0, marker);
  const transitional = barrel.slice(marker);

  it('S10 AS-68: the entry point exports no model, infra class or job handler outside the marked TRANSITIONAL block', () => {
    expect(marker).toBeGreaterThan(0);
    const names = exportedNames(stable);
    expect(names.filter((n) => /Model$/.test(n))).toEqual([]);
    expect(stable).not.toMatch(/\/infra\//);
    expect(
      names.filter((n) => /(Jobs|Repository|Adapter|Consumer)$/.test(n)),
    ).toEqual([]);
    for (const name of [
      'OrderQueryService',
      'OrderFulfilmentService',
      'OrderNotPayableError',
      'TooManyIdsError',
      'OrderReserved',
      'OrderPaid',
      'OrderCancelled',
      'OrderRefunded',
      'OrderFulfilmentChanged',
    ])
      expect(names).toContain(name);
  });

  it('S10 AS-68: the TRANSITIONAL block can only shrink (every name is on the allowed list)', () => {
    const extra = exportedNames(transitional).filter(
      (n) => !TRANSITIONAL_ALLOWED.includes(n),
    );
    expect(extra).toEqual([]);
  });

  it('S10 AS-68: the models have no association or import into another domain (user, product and payment ids are plain columns)', () => {
    const models = sources.filter((f) => /\.model\.ts$/.test(f));
    expect(models.length).toBeGreaterThanOrEqual(5);
    for (const file of models) {
      const code = text(file);
      expect(code).not.toMatch(/@app\/domains\//);
      for (const decorator of code.match(
        /@(BelongsTo|HasMany|HasOne|BelongsToMany)\(\(\) => (\w+)/g,
      ) ?? [])
        expect(['BisOrder']).toContain(decorator.split('=> ')[1]);
    }
    expect(matching(/\b(UserModel|ProductModel|PaymentModel)\b/)).toEqual([]);
  });

  it('S10 AS-68: every table the registered models map to is owned by orders in the registry', () => {
    const owned = new Set<string>(ownedBy('domain:orders'));
    const tables = ORDER_MODELS.map(
      (m) => getOptions(m.prototype as object)?.tableName as string,
    );
    expect(tables).toHaveLength(ORDER_MODELS.length);
    for (const table of tables) expect(owned).toContain(table);
    for (const table of ['OrderEvent', 'StockReservation', 'ShopOrder'])
      expect(owned).toContain(table);
  });

  it('S10 AS-68: no direct sequelize.transaction and no S54 audit comment is left in the domain', () => {
    expect(matching(/\bsequelize\.transaction\(/)).toEqual([]);
    expect(matching(/S54 T037 audit/)).toEqual([]);
  });

  it('S10 AS-68: no SessionNotRevokedGuard, @SkipThrottle or throttle arguments remain', () => {
    expect(matching(/SessionNotRevokedGuard/)).toEqual([]);
    expect(matching(/SkipThrottle/)).toEqual([]);
    expect(matching(/\b(skipThrottle|throttle)\s*:/)).toEqual([]);
  });

  it('S10 AS-68: application and api code import nothing from infra (ports only)', () => {
    const layered = sources.filter((f) =>
      /\/(application|api)\//.test(f.replace(DOMAIN, '')),
    );
    expect(matching(/from '\.\.\/infra\//, layered)).toEqual([]);
  });

  it('S10 AS-68: no table-ownership finding is left for orders (the S12 export join on Product is gone)', () => {
    const out = execFileSync('pnpm', ['check:table-ownership'], {
      cwd: BACKEND,
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    const section = out.split(/\n(?=\S)/).find((s) => s.startsWith('orders'));
    expect(section).toBeUndefined();
  });

  describe('S12 order export', () => {
    const exportSources = sources.filter((f) =>
      /\/(order-export[^/]*|export-[^/]*)\.ts$/.test(f.replace(/\\/g, '/')),
    );

    it('S12 AS-57: the barrel exports the three export modules and neither OrderExportService nor ExportJobTopicsModule', () => {
      const names = exportedNames(barrel);
      for (const name of [
        'OrderExportModule',
        'OrderExportWorkerModule',
        'OrderExportTopicsModule',
      ])
        expect(names).toContain(name);
      expect(names).not.toContain('OrderExportService');
      expect(names).not.toContain('ExportJobTopicsModule');
      expect(
        names.filter((n) => /^(Export|OrderExport)\w*Model$/.test(n)),
      ).toEqual([]);
      expect(TRANSITIONAL_ALLOWED).not.toContain('OrderExportService');
      expect(TRANSITIONAL_ALLOWED).not.toContain('ExportJobTopicsModule');
    });

    it("S12 AS-57: the export files open no transaction directly, read no other domain's table or model, and import nothing from catalog-sync", () => {
      expect(exportSources.length).toBeGreaterThanOrEqual(15);
      expect(matching(/\bsequelize\.transaction\(/, exportSources)).toEqual([]);
      expect(matching(/S54 T037 audit/, exportSources)).toEqual([]);
      expect(
        matching(
          /"(Product|Shop|User|Payment|ShopMembership)"|\b(ProductModel|ShopModel|UserModel|PaymentModel)\b/,
          exportSources,
        ),
      ).toEqual([]);
      expect(matching(/catalog-sync/, exportSources)).toEqual([]);
    });

    it('S12 AS-57: orders registers no job: realtime topic, and no export code is left in catalog-sync', () => {
      expect(matching(/prefix:\s*'job'/)).toEqual([]);
      expect(matching(/OrderExportService|ExportJobTopics\b/)).toEqual([]);
      const catalogSync = walk(join(DOMAIN, '..', 'catalog-sync')).filter(
        (f) => f.endsWith('.ts') && !/\.(e2e-)?spec\.ts$/.test(f),
      );
      expect(matching(/@app\/domains\/orders/, catalogSync)).toEqual([]);
      expect(
        matching(/kind:\s*'export'|kind === 'export'/, catalogSync),
      ).toEqual([]);
    });
  });

  it('S10 AS-68: the dependency rules are green', () => {
    const out = execFileSync('pnpm', ['check:boundaries'], {
      cwd: BACKEND,
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    expect(out).toContain('no dependency violations found');
  });
});
