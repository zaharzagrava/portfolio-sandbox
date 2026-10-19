import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const JOURNEYS = join(__dirname, '../../../test/journeys');

// J04 journey and support files: every wait is a contract hop, never a fixed delay (SC-009, L-003, L-007).
const FILES = [
  'catalog-sync-to-search.journey-spec.ts',
  'support/catalog-fixture.ts',
  'support/control-surface.ts',
  'support/pickup-fixture.ts',
  'support/scanner-double.ts',
  'support/shopify-double.ts',
  'support/shopify-fixture.ts',
  'support/sse-client.ts',
  'support/wait-for-contract.ts',
];

const DELAY = /\bsetTimeout\s*\(|\bsleep\s*\(|\bdelay\s*\(/;

describe('J04 no-sleep check', () => {
  it.each(FILES)('J04 SC-009: %s has no fixed delay', (file) => {
    const hits = readFileSync(join(JOURNEYS, file), 'utf8')
      .split('\n')
      .map((text, i) => ({ text, line: i + 1 }))
      .filter(({ text }) => DELAY.test(text) && !/^\s*(\/\/|\*)/.test(text));
    expect(hits).toEqual([]);
  });
});
