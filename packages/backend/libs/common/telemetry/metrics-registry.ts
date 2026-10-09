import { metrics } from '@opentelemetry/api';

type MetricType = 'counter' | 'histogram' | 'gauge';
export type Labels = Record<string, string | number | boolean>;

interface BaseDefinition {
  name: string;
  help: string;
  labels: string[];
}
export type HistogramDefinition = BaseDefinition & { buckets: number[] };

/** Identifiers of people and requests make unbounded series; they belong in logs and traces (FR-080). */
const FORBIDDEN_LABELS = new Set([
  'userid',
  'shopid',
  'requestid',
  'email',
  'ip',
  'url',
  'path',
]);
const SNAKE_CASE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const HISTOGRAM_UNITS = ['_seconds', '_bytes', '_ratio'];
/** Series ceiling per metric; the excess is counted in one overflow series instead of growing without bound. */
export const MAX_SERIES_PER_METRIC = 2_000;
const OVERFLOW_LABELS: Labels = { overflow: 'true' };

const seriesKey = (labels: Labels): string =>
  JSON.stringify(
    Object.keys(labels)
      .sort()
      .map((k) => [k, labels[k]]),
  );

interface Entry {
  type: MetricType;
  definition: BaseDefinition & { buckets?: number[] };
  values: Map<string, { labels: Labels; value: number; count?: number }>;
}

const registry = new Map<string, Entry>();

function validate(type: MetricType, def: BaseDefinition): void {
  const { name } = def;
  if (!SNAKE_CASE.test(name))
    throw new Error(`Metric "${name}": names are lowercase snake case`);
  if (type === 'counter' && !name.endsWith('_total'))
    throw new Error(`Metric "${name}": counters end in _total`);
  if (
    type === 'histogram' &&
    !HISTOGRAM_UNITS.some((unit) => name.endsWith(unit))
  ) {
    throw new Error(
      `Metric "${name}": histograms end in a unit suffix (${HISTOGRAM_UNITS.join(', ')})`,
    );
  }
  for (const label of def.labels) {
    if (FORBIDDEN_LABELS.has(label.replace(/_/g, '').toLowerCase()))
      throw new Error(
        `Metric "${name}": label "${label}" is forbidden (unbounded cardinality)`,
      );
  }
}

function register(
  type: MetricType,
  def: BaseDefinition & { buckets?: number[] },
): Entry {
  validate(type, def);
  const existing = registry.get(def.name);
  if (existing) {
    const same =
      existing.type === type &&
      [...existing.definition.labels].sort().join() ===
        [...def.labels].sort().join();
    if (!same)
      throw new Error(
        `Metric "${def.name}" is already registered as a ${existing.type} with labels [${existing.definition.labels.join(', ')}]`,
      );
    return existing;
  }
  const entry: Entry = { type, definition: def, values: new Map() };
  registry.set(def.name, entry);
  return entry;
}

function slot(
  entry: Entry,
  labels: Labels,
): { labels: Labels; value: number; count?: number } {
  let key = seriesKey(labels);
  let found = entry.values.get(key);
  if (!found) {
    if (
      entry.values.size >=
      MAX_SERIES_PER_METRIC +
        (entry.values.has(seriesKey(OVERFLOW_LABELS)) ? 1 : 0)
    ) {
      labels = OVERFLOW_LABELS;
      key = seriesKey(labels);
      found = entry.values.get(key);
    }
    if (!found) {
      found = { labels, value: 0, count: 0 };
      entry.values.set(key, found);
    }
  }
  return found;
}

export interface CounterHandle {
  add(value?: number, labels?: Labels): void;
}
export interface GaugeHandle {
  set(value: number, labels?: Labels): void;
}
export interface HistogramHandle {
  record(value: number, labels?: Labels): void;
}

/**
 * One place that creates metric instruments (S54 FR-080): enforces names and units, refuses unbounded labels and
 * conflicting duplicates at registration (so a bad metric fails startup), caps series per metric, and keeps an
 * in-process view that specs read with `value()` without needing an exporter.
 */
export const MetricsRegistry = {
  counter(def: BaseDefinition): CounterHandle {
    const entry = register('counter', def);
    const otel = metrics
      .getMeter('platform')
      .createCounter(def.name, { description: def.help });
    return {
      add(value = 1, labels = {}) {
        slot(entry, labels).value += value;
        otel.add(
          value,
          entry.values.has(seriesKey(labels)) ? labels : OVERFLOW_LABELS,
        );
      },
    };
  },

  histogram(def: HistogramDefinition): HistogramHandle {
    const entry = register('histogram', def);
    const otel = metrics.getMeter('platform').createHistogram(def.name, {
      description: def.help,
      advice: { explicitBucketBoundaries: def.buckets },
    });
    return {
      record(value, labels = {}) {
        const s = slot(entry, labels);
        s.value += value;
        s.count = (s.count ?? 0) + 1;
        otel.record(
          value,
          entry.values.has(seriesKey(labels)) ? labels : OVERFLOW_LABELS,
        );
      },
    };
  },

  gauge(def: BaseDefinition): GaugeHandle {
    const existed = registry.has(def.name);
    const entry = register('gauge', def);
    if (!existed) {
      metrics
        .getMeter('platform')
        .createObservableGauge(def.name, { description: def.help })
        .addCallback((result) => {
          for (const s of entry.values.values())
            result.observe(s.value, s.labels);
        });
    }
    return {
      set(value, labels = {}) {
        slot(entry, labels).value = value;
      },
    };
  },

  /** Current value of a counter or gauge series (specs and health reporting). */
  value(name: string, labels: Labels = {}): number | undefined {
    return registry.get(name)?.values.get(seriesKey(labels))?.value;
  },

  histogramValue(
    name: string,
    labels: Labels = {},
  ): { count: number; sum: number } | undefined {
    const s = registry.get(name)?.values.get(seriesKey(labels));
    return s ? { count: s.count ?? 0, sum: s.value } : undefined;
  },

  /** Label sets currently recorded for a metric (specs assert nothing sensitive became a label). */
  labelSets(name: string): Labels[] {
    return [...(registry.get(name)?.values.values() ?? [])].map(
      (s) => s.labels,
    );
  },

  seriesCount(name: string): number {
    return registry.get(name)?.values.size ?? 0;
  },

  /** Test helper: forget every registration. */
  reset(): void {
    registry.clear();
  },
};
