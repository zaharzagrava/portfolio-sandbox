import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DOMAIN = __dirname;
const OWN_TABLES = new Set([
  'ShopFunction',
  'ShopFunctionVersion',
  'ShopFunctionTestCase',
  'ShopFunctionVersionHistory',
]);

/** Production sources of the domain: no spec, no testing kit. */
function sources(dir = DOMAIN): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory())
      return name === 'testing' ? [] : sources(path);
    return name.endsWith('.ts') && !/\.(e2e-)?spec\.ts$/.test(name)
      ? [path]
      : [];
  });
}
const code = (file: string) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join('\n');

describe('S45 AS-38: boundaries and ownership (static)', () => {
  it('the entry point exports the modules, the evaluation service, its two DTO types and the runner program only', () => {
    const barrel = readFileSync(join(DOMAIN, 'index.ts'), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n');
    const names = [
      ...barrel.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g),
    ].flatMap((m) =>
      m[1]
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean),
    );

    expect(names.sort()).toEqual(
      [
        'DiscountCartDto',
        'DiscountEvaluationDto',
        'DiscountEvaluationModule',
        'DiscountEvaluationService',
        'FunctionJudgeModule',
        'ShopFunctionsModule',
        'startRunnerServer',
      ].sort(),
    );
    for (const name of names)
      expect(name).not.toMatch(/Model$|Repository|Sandbox|Cache|Store|Token/);
  });

  it('nothing in the domain imports orders or another domain except through its entry point', () => {
    for (const file of sources()) {
      const text = code(file);
      expect(text).not.toMatch(/@app\/domains\/orders/);
      for (const m of text.matchAll(
        /from '@app\/domains\/([a-z-]+)(\/[^']*)?'/g,
      ))
        if (m[1] !== 'shop-functions') expect(m[2]).toBeUndefined();
    }
  });

  it('no @Global module, no direct sequelize transaction, no audit comment', () => {
    for (const file of sources()) {
      expect(code(file)).not.toMatch(/@Global\(/);
      expect(code(file)).not.toMatch(/[sS]equelize\w*\.transaction\(/);
      expect(readFileSync(file, 'utf8')).not.toContain('S54 T037 audit');
    }
  });

  it('every query touches only the tables of this domain', () => {
    const touched = new Set<string>();
    for (const file of sources().filter((f) => !f.includes('/migrations/')))
      for (const m of code(file).matchAll(
        /\b(?:FROM|JOIN|INTO|UPDATE)\s+"([A-Za-z]+)"/g,
      ))
        touched.add(m[1]);
    expect([...touched].filter((t) => !OWN_TABLES.has(t))).toEqual([]);
    expect(touched.size).toBe(OWN_TABLES.size);
  });
});
