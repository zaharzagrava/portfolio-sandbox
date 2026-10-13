import type {
  AdClickRecord,
  MinuteAggregate,
} from '@marketplace-sandbox/contracts';

/** What the aggregation reads of a click record. */
export type AggregationInput = Pick<
  AdClickRecord,
  'click_id' | 'campaign_id' | 'received_at' | 'valid'
>;

/** FR-036: a click older than this at processing time is counted into its own minute and measured as late. */
export const LATE_ALLOWANCE_MS = 2 * 60_000;

const receivedAtMs = (receivedAt: string): number =>
  Date.parse(`${receivedAt.replace(' ', 'T')}Z`);

export const isLate = (receivedAt: string, nowMs: number): boolean =>
  nowMs - receivedAtMs(receivedAt) > LATE_ALLOWANCE_MS;

/**
 * The first recorded verdict of a click id (FR-034): earliest `received_at`; on a tie the invalid verdict, then the
 * campaign id, so that the choice does not depend on the order of the batch (and under-billing beats over-billing).
 */
const firstRecorded = (a: AggregationInput, b: AggregationInput): number =>
  (a.received_at < b.received_at
    ? -1
    : a.received_at > b.received_at
      ? 1
      : 0) ||
  a.valid - b.valid ||
  (a.campaign_id < b.campaign_id ? -1 : a.campaign_id > b.campaign_id ? 1 : 0);

export function dedupeFirstVerdict(
  records: readonly AggregationInput[],
): AggregationInput[] {
  const byClick = new Map<string, AggregationInput>();
  for (const record of records) {
    const kept = byClick.get(record.click_id);
    if (!kept || firstRecorded(record, kept) < 0)
      byClick.set(record.click_id, record);
  }
  return [...byClick.values()];
}

/**
 * One Kafka batch -> per (campaign, minute of `received_at`) counts, tagged with the batch identity
 * (source partition, offset of the batch's first message). A click id counts once; the output does not depend on the
 * order of the records and is sorted, so a redelivered batch yields byte-identical rows (FR-033, AS-42).
 */
export function aggregateBatch(
  partition: number,
  firstOffset: number,
  records: readonly AggregationInput[],
): MinuteAggregate[] {
  const byKey = new Map<string, MinuteAggregate>();
  for (const r of dedupeFirstVerdict(records)) {
    const minute = `${r.received_at.slice(0, 16)}:00`;
    const key = `${r.campaign_id}|${minute}`;
    const row = byKey.get(key) ?? {
      campaign_id: r.campaign_id,
      minute,
      source_partition: partition,
      first_offset: firstOffset,
      clicks: 0,
      invalid: 0,
    };
    if (r.valid === 1) row.clicks++;
    else row.invalid++;
    byKey.set(key, row);
  }
  return [...byKey.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, row]) => row);
}
