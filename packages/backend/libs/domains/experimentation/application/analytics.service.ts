import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { v4 } from 'uuid';
import { KafkaProducerService } from '@app/infrastructure/kafka/kafka-producer.service';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { CacheService } from '@app/infrastructure/cache/cache.service';
import { ANALYTICS_TOPIC, ClientBatch, ClientEvent, StoredEvent, toStored } from '../domain/event-schema';
import { assign, ExperimentDef } from '../domain/experiments';
import { srmCheck, twoProportionZTest } from '../domain/stats';

@Injectable()
export class AnalyticsService {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly producer: KafkaProducerService,
    private readonly clickhouse: ClickHouseService,
    private readonly cache: CacheService,
  ) {}

  /**
   * Backend fallback for `/collect` (the edge is the primary path). Partial
   * acceptance: valid events go to Kafka, invalid ones are reported back by
   * index (a client bug in one event shouldn't drop the other 49).
   */
  async ingest(body: unknown, meta: { userId?: string; country?: string; platform?: string }) {
    const batch = ClientBatch.safeParse(body);
    if (!batch.success) throw new BadRequestException('Body must be { events: [1..50] }');
    const accepted: StoredEvent[] = [];
    const rejected: { index: number; error: string }[] = [];
    batch.data.events.forEach((raw, index) => {
      const parsed = ClientEvent.safeParse(raw);
      if (!parsed.success) return rejected.push({ index, error: parsed.error.issues[0]?.message ?? 'invalid' });
      const stored = toStored(parsed.data, meta);
      if (!stored) rejected.push({ index, error: 'event too old' });
      else accepted.push(stored);
    });
    await this.producer.sendMany(ANALYTICS_TOPIC, accepted.map((e) => ({ key: e.anonymous_id, value: e })));
    return { accepted: accepted.length, rejected };
  }

  /** Server-rendered exposure (e.g. a variant chosen in the BFF): logged like a client exposure. */
  async logExposure(experiment: string, variant: string, unit: { userId?: string; anonymousId: string }) {
    const now = Date.now();
    const event = toStored({ event_id: v4(), name: 'exposure', anonymous_id: unit.anonymousId, ts: now, props: { experiment, variant } }, { userId: unit.userId, platform: 'server' }, now)!;
    await this.producer.sendMany(ANALYTICS_TOPIC, [{ key: event.anonymous_id, value: event }]);
  }

  async experiments(): Promise<(ExperimentDef & { metric: string })[]> {
    return (
      (await this.cache.getOrLoad('experiments:running', () => this.sequelize.query<ExperimentDef & { metric: string }>(`SELECT key, status, variants, layer, "layerFrom", "layerTo", metric FROM "Experiment" WHERE status = 'RUNNING'`, { type: QueryTypes.SELECT }), { ttlMs: 30_000, l1: 'always', l1TtlMs: 10_000 })) ?? []
    );
  }

  /** Assignments for the caller across running experiments (the client logs `exposure` when it renders one). */
  async assignments(unit: string): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const exp of await this.experiments()) {
      const variant = assign(exp, unit);
      if (variant) result[exp.key] = variant;
    }
    return result;
  }

  /**
   * Readout from ClickHouse (FINAL → duplicates removed):
   *   unit = user_id if known else anonymous_id; first exposure per unit decides its variant;
   *   converted = the unit fired the metric event AFTER its first exposure.
   * Plus z-test per variant vs control (first variant) and the SRM check.
   */
  async results(key: string) {
    const [exp] = await this.sequelize.query<ExperimentDef & { metric: string; startedAt: Date | null }>(`SELECT * FROM "Experiment" WHERE key = :key`, { type: QueryTypes.SELECT, replacements: { key } });
    if (!exp) throw new NotFoundException('Unknown experiment');
    const rows = await this.clickhouse.query<{ variant: string; exposures: string; conversions: string }>(
      `WITH exposures AS (
         SELECT if(user_id != '', user_id, anonymous_id) AS unit, argMin(props['variant'], ts) AS variant, min(ts) AS first_seen
         FROM analytics_events FINAL
         WHERE name = 'exposure' AND props['experiment'] = {key:String} AND ts >= {from:DateTime64(3)}
         GROUP BY unit
       ), conversions AS (
         SELECT if(user_id != '', user_id, anonymous_id) AS unit, min(ts) AS converted_at
         FROM analytics_events FINAL
         WHERE name = {metric:String} AND ts >= {from:DateTime64(3)}
         GROUP BY unit
       )
       SELECT e.variant AS variant, count() AS exposures, countIf(c.converted_at >= e.first_seen) AS conversions
       FROM exposures e LEFT JOIN conversions c ON c.unit = e.unit
       GROUP BY variant`,
      { key, metric: exp.metric, from: (exp.startedAt ? new Date(exp.startedAt) : new Date(0)).toISOString().replace('T', ' ').replace('Z', '') },
    );
    const byVariant = new Map(rows.map((r) => [r.variant, { exposures: Number(r.exposures), conversions: Number(r.conversions) }]));
    const control = exp.variants[0].key;
    const controlStats = byVariant.get(control) ?? { exposures: 0, conversions: 0 };
    const srm = srmCheck(exp.variants.map((v) => byVariant.get(v.key)?.exposures ?? 0), exp.variants.map((v) => v.weight));
    return {
      experiment: key,
      metric: exp.metric,
      srm,
      trustworthy: !srm.mismatch,
      variants: exp.variants.map((v) => {
        const s = byVariant.get(v.key) ?? { exposures: 0, conversions: 0 };
        return {
          variant: v.key,
          ...s,
          conversionRate: s.exposures ? s.conversions / s.exposures : 0,
          ...(v.key !== control && controlStats.exposures && s.exposures && { vsControl: twoProportionZTest(controlStats, s) }),
        };
      }),
    };
  }

  async upsertExperiment(def: ExperimentDef & { metric: string; description?: string }) {
    await this.sequelize.query(
      `INSERT INTO "Experiment" (key, description, status, variants, layer, "layerFrom", "layerTo", metric, "startedAt")
       VALUES (:key, :description, :status, CAST(:variants AS jsonb), :layer, :layerFrom, :layerTo, :metric, CASE WHEN :status = 'RUNNING' THEN now() END)
       ON CONFLICT (key) DO UPDATE SET status = EXCLUDED.status, description = EXCLUDED.description,
         "startedAt" = CASE WHEN EXCLUDED.status = 'RUNNING' AND "Experiment"."startedAt" IS NULL THEN now() ELSE "Experiment"."startedAt" END,
         "stoppedAt" = CASE WHEN EXCLUDED.status = 'STOPPED' THEN now() ELSE NULL END`,
      { replacements: { ...def, description: def.description ?? '', variants: JSON.stringify(def.variants) } },
    );
    // Variants/layer slots are immutable once created: changing them mid-run would invalidate the analysis.
    await this.cache.invalidate(['experiments:running']);
  }
}
