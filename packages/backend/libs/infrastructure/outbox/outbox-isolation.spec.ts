import {
  HANDED_OVER,
  scanTechnicalTables,
  technicalTableViolations,
} from '../../../scripts/technical-table-scan';

describe('Outbox and inbox tables are reached through their services only', () => {
  const refs = scanTechnicalTables();

  it('S53 AS-09: no domain or app names the outbox or inbox tables in SQL or imports their models, apart from the files handed to their owners', () => {
    const { unexpected } = technicalTableViolations(refs);
    expect(unexpected).toEqual([]);
  });

  it('S53 AS-09: the files handed to other specs still reference a technical table (an entry that no longer does must be removed)', () => {
    expect(technicalTableViolations(refs).stale).toEqual([]);
  });

  it('S53 AS-09: the hand-over list is exactly the three known files, each naming the spec that fixes it', () => {
    expect(Object.keys(HANDED_OVER).sort()).toEqual([
      'libs/domains/catalog-sync/application/catalog-import.service.ts',
      'libs/domains/media/infra/media-processor.ts',
      'libs/domains/orders/api/stripe-webhook.controller.ts',
    ]);
    for (const owner of Object.values(HANDED_OVER))
      expect(owner).toMatch(/^S\d+ /);
  });

  it('S53 AS-09: the scan sees the outbox table in the handed-over files (it would catch a new reference)', () => {
    const tables = refs
      .filter((r) => r.file in HANDED_OVER)
      .map((r) => r.table);
    expect(tables).toEqual(
      expect.arrayContaining(['Outbox', 'ProcessedWebhookEvent']),
    );
  });
});
