import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.ts$/.test(name) &&
      !/\.(e2e-)?spec\.ts$/.test(name) &&
      !path.includes(`${ROOT}/testing`)
      ? [path]
      : [];
  });
}

/** Tables other domains own: no query of the statements may name them (IX.4, IX.7: events and R1 exports only). */
const FOREIGN_TABLES = [
  'BisOrder',
  'BisOrderItem',
  'Product',
  'Shop',
  'ShopMembership',
  'LedgerEntry',
  'LedgerJournal',
  'LedgerAccount',
  'Payout',
];

describe('Statements: boundaries', () => {
  const files = sources(ROOT);

  it("S16 AS-77: no file of the domain queries another domain's table", () => {
    expect(files.length).toBeGreaterThan(30);
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const table of FOREIGN_TABLES) {
        if (new RegExp(`"${table}"`).test(text))
          offenders.push(`${relative(ROOT, file)} names "${table}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('S16 AS-77: no file imports another domain except through its public entry point', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/from '(@app\/domains\/[^']+)'/g)) {
        const target = match[1].replace('@app/domains/', '');
        if (target.includes('/'))
          offenders.push(`${relative(ROOT, file)} imports ${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("S16 AS-77: the domain holds no foreign key to another domain's table and no model of one", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      if (/REFERENCES\s+"/i.test(text))
        offenders.push(`${relative(ROOT, file)} declares a foreign key`);
      if (
        /@nestjs\/sequelize'/.test(text) &&
        /getModelToken|InjectModel/.test(text) &&
        !file.includes('/infra/')
      )
        offenders.push(`${relative(ROOT, file)} injects a model outside infra`);
    }
    expect(offenders).toEqual([]);
  });
});
