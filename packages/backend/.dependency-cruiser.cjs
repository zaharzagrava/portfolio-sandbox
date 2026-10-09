/**
 * Boundary rules from constitution v3.1.0 §X (X.4 entry points, X.5 dependency directions, X.8 composition).
 * Run: pnpm check:boundaries   (errors fail; warnings are recorded debt, see docs/architecture/debt-register.md)
 *
 * Paths are relative to packages/backend. Spec files (*.spec.ts, *.e2e-spec.ts) are tests: they may use the
 * harness in test/ and wire apps, so they're exempt from the production-only rules.
 */
const SPEC = '\\.(e2e-)?spec\\.ts$';

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'x1-nothing-imports-apps',
      comment: 'X.1: apps/ are deployment units; nothing imports from them.',
      severity: 'error',
      from: { path: '^(libs|test|db)/' },
      to: { path: '^apps/' },
    },
    {
      name: 'x6-production-never-imports-test',
      comment: 'The e2e harness (test/) is for specs only. Test-only kits under libs/**/testing/ support specs.',
      severity: 'error',
      from: { path: '^(apps|libs)/', pathNot: [SPEC, '^libs/.*/testing/'] },
      to: { path: '^test/' },
    },
    {
      name: 'x5-infrastructure-is-domain-agnostic',
      comment: 'X.3/X.5: infrastructure imports only infrastructure, common and third-party code.',
      severity: 'error',
      from: { path: '^libs/infrastructure/', pathNot: SPEC },
      to: { path: '^libs/(domains|composition)/' },
    },
    {
      name: 'x5-common-imports-only-common',
      comment: 'X.5: common never imports infrastructure, domains or composition.',
      severity: 'error',
      from: { path: '^libs/common/', pathNot: SPEC },
      to: { path: '^libs/(infrastructure|domains|composition)/' },
    },
    {
      name: 'x8-composition-never-imports-domains',
      comment: 'X.8.2: composition talks to domains over HTTP only.',
      severity: 'error',
      from: { path: '^libs/composition/' },
      to: { path: '^libs/domains/' },
    },
    {
      name: 'x8-composition-infrastructure-allowlist',
      comment: 'X.8.4: composition may use only http-client, net, cache, redis and rate-limit.',
      severity: 'error',
      from: { path: '^libs/composition/', pathNot: SPEC },
      to: { path: '^libs/infrastructure/', pathNot: '^libs/infrastructure/(http-client|net|cache|redis|rate-limit)/' },
    },
    {
      name: 'x5-domains-never-import-composition',
      comment: 'X.5: domains never import composition.',
      severity: 'error',
      from: { path: '^libs/domains/' },
      to: { path: '^libs/composition/' },
    },
    {
      name: 'x4-domain-entry-point-only',
      comment: 'X.4: outside a domain, import only libs/domains/<d>/index.ts (@app/domains/<d>).',
      severity: 'error',
      from: { path: '^(apps|libs|test|db)/', pathNot: '^libs/domains/([^/]+)/' },
      to: { path: '^libs/domains/[^/]+/', pathNot: '^libs/domains/[^/]+/index\\.ts$' },
    },
    {
      name: 'x4-other-domain-entry-point-only',
      comment: 'X.4: a domain imports another domain only through its index.ts.',
      severity: 'error',
      from: { path: '^libs/domains/([^/]+)/' },
      to: { path: '^libs/domains/[^/]+/', pathNot: ['^libs/domains/$1/', '^libs/domains/[^/]+/index\\.ts$'] },
    },
    {
      name: 'x5-no-circular',
      comment:
        'X.5: no import cycles. Known, recorded (not fixed in Phase 3): the orders/payments/catalog/discovery/experimentation ' +
        'cycle (D-11, D-12, D-15) and cycles through barrels inside it. Warn-only until that debt is paid, then raise to error.',
      severity: 'warn',
      from: { pathNot: SPEC },
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '^(dist|node_modules|coverage|scripts/refactor)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require', 'node', 'default'], extensions: ['.ts', '.js', '.json'] },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
