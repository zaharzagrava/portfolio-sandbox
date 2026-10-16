import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import {
  HANDED_OVER,
  scanTechnicalTables,
  technicalTableViolations,
} from '../../../scripts/technical-table-scan';

const BACKEND = join(__dirname, '../../..');

describe('Outbox and inbox tables are reached through their services only', () => {
  const refs = scanTechnicalTables();

  it('S53 AS-09: no domain or app names the outbox or inbox tables in SQL or imports their models, apart from the files handed to their owners', () => {
    const { unexpected } = technicalTableViolations(refs);
    expect(unexpected).toEqual([]);
  });

  it('S53 AS-09: the files handed to other specs still reference a technical table (an entry that no longer does must be removed)', () => {
    expect(technicalTableViolations(refs).stale).toEqual([]);
  });

  it('S53 AS-09: the hand-over list is empty (S07 moved its last raw outbox write to the service); any entry must name the spec that fixes it', () => {
    expect(Object.keys(HANDED_OVER)).toEqual([]);
    for (const owner of Object.values(HANDED_OVER))
      expect(owner).toMatch(/^S\d+ /);
  });

  it('S53 AS-09: the scan sees the outbox table in a file outside the owning lib (it would catch a new reference)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'outbox-scan-'));
    try {
      writeFileSync(
        join(dir, 'bad.ts'),
        'const q = `INSERT INTO "Outbox" (id)`;',
      );
      const found = scanTechnicalTables([relative(BACKEND, dir)]);
      expect(found.map((r) => r.table)).toEqual(['Outbox']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
