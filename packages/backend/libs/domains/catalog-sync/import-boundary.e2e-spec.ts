import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { QueryTypes } from 'sequelize';
import { boundaryCheck, ownershipCheck } from '@app/test/utils/static-checks';
import { createImportApp, type ImportKit } from './testing/import-kit';
import * as barrel from './index';

const DOMAIN = __dirname;
const BACKEND = join(DOMAIN, '..', '..', '..');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

/** The files of the bulk import (S07): not the integrations (S08) or offline sync (S09) that share the domain folder. */
const importFiles = walk(DOMAIN)
  .map((file) => relative(DOMAIN, file))
  .filter((file) => file.endsWith('.ts'))
  .filter(
    (file) =>
      !/\.(e2e-)?spec\.ts$/.test(file) &&
      !file.startsWith('test/') &&
      !file.startsWith('testing/'),
  )
  .filter(
    (file) =>
      /(^|\/)(catalog-)?import[-.]/.test(file) ||
      file === 'infra/repositories/sequelize-import.repository.ts',
  );

describe('Catalog-sync import module boundary', () => {
  let kit: ImportKit;

  beforeAll(async () => {
    kit = await createImportApp();
  });
  afterAll(async () => {
    await kit.close();
  });

  it('S07 AS-69: the import files are found, so the checks below cannot pass over nothing', () => {
    expect(importFiles).toEqual(
      expect.arrayContaining([
        'application/import-runner.service.ts',
        'application/import-start.service.ts',
        'api/catalog-import.controller.ts',
        'infra/repositories/sequelize-import.repository.ts',
        'catalog-import.module.ts',
      ]),
    );
  });

  it('S07 AS-69: the table-ownership gate reports nothing for the import files, and the module-boundary gate finds no violation', async () => {
    // the two gates do not depend on each other: run them side by side
    const [ownership, boundaries] = await Promise.all([
      ownershipCheck(BACKEND, ['--strict']),
      boundaryCheck(BACKEND),
    ]);
    const lines = `${ownership.stdout}\n${ownership.stderr}`.split('\n');
    const mine = lines.filter(
      (line) =>
        line.includes('libs/domains/catalog-sync/') &&
        importFiles.some((f) => line.includes(f)),
    );
    expect(mine).toEqual([]);
    expect(
      lines.filter(
        (line) => line.includes('STALE') && line.includes('catalog-sync'),
      ),
    ).toEqual([]);

    expect([boundaries.status, boundaries.stdout.slice(-400)]).toEqual([
      0,
      expect.stringContaining('no dependency violations'),
    ]);
  }, 300_000);

  it('S07 AS-69: the import tables have no foreign key to another domain and the barrel exports no model', async () => {
    const foreign = await kit.db.query<{ conname: string; table: string }>(
      `SELECT c.conname, c.conrelid::regclass::text AS "table"
         FROM pg_constraint c
        WHERE c.contype = 'f' AND (c.conrelid::regclass::text IN ('"ImportJob"', '"ImportJobHistory"', 'ImportJob', 'ImportJobHistory')
           OR c.confrelid::regclass::text IN ('"ImportJob"', '"ImportJobHistory"', 'ImportJob', 'ImportJobHistory'))`,
      { type: QueryTypes.SELECT },
    );
    expect(foreign).toEqual([]);
    expect(Object.keys(barrel).filter((name) => /Model$/.test(name))).toEqual(
      [],
    );
  });

  it('S07 AS-69: no import file carries a throttle option, a direct transaction, raw product or outbox SQL, the old clamav shim, a job: topic or a job kind', () => {
    const forbidden: Array<[string, RegExp]> = [
      ['throttle option', /\bthrottle\b|skipThrottle/],
      ['session-revoked guard', /SessionNotRevokedGuard/],
      ['direct transaction', /sequelize\.transaction/],
      ['raw product write', /(INSERT INTO|UPDATE)\s+"Product"/],
      ['raw outbox write', /INSERT INTO\s+"Outbox"/],
      ['old concurrency policy', /imports\.concurrent/],
      ['clamav shim', /infra\/clamav/],
      ['job: topic', /['"`]job:/],
      ['job kind', /\bkind:\s*['"](import|export)['"]/],
      ['export service', /OrderExportService/],
    ];
    const hits: string[] = [];
    for (const file of importFiles) {
      const source = readFileSync(join(DOMAIN, file), 'utf8');
      for (const [name, pattern] of forbidden)
        if (pattern.test(source)) hits.push(`${file}: ${name}`);
    }
    expect(hits).toEqual([]);
  });
});
