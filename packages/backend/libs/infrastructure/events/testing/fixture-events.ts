import {
  fixtureCounterBumpedV1Schema,
  fixtureItemChangedV1Schema,
  fixtureItemRenamedV1Schema,
  fixtureItemRenamedV2Schema,
  fixtureReindexCompletedV1Schema,
} from '@marketplace-sandbox/contracts';
import { defineEvent } from '../define-event';

/** Test-only aggregate used by the S53 e2e specs; imports no domain (X.5). */
export const FIXTURE_AGGREGATE = 'fixtures';

export const FixtureItemChanged = defineEvent(
  'fixtures.item_changed',
  FIXTURE_AGGREGATE,
  1,
  fixtureItemChangedV1Schema,
  { carries: 'state' },
);

export const FixtureItemRenamedV1 = defineEvent(
  'fixtures.item_renamed',
  FIXTURE_AGGREGATE,
  1,
  fixtureItemRenamedV1Schema,
  { carries: 'state' },
);

export const FixtureItemRenamedV2 = defineEvent(
  'fixtures.item_renamed',
  FIXTURE_AGGREGATE,
  2,
  fixtureItemRenamedV2Schema,
  { carries: 'state' },
);

export const FixtureReindexCompleted = defineEvent(
  'fixtures.reindex_completed',
  FIXTURE_AGGREGATE,
  1,
  fixtureReindexCompletedV1Schema,
  { carries: 'state' },
);

export const FixtureCounterBumped = defineEvent(
  'fixtures.counter_bumped',
  FIXTURE_AGGREGATE,
  1,
  fixtureCounterBumpedV1Schema,
  { carries: 'delta' },
);
