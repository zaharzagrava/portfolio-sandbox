import { Logger } from '@nestjs/common';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import type {
  MediaLogFields,
  MediaLogger,
  MediaMetricName,
  MediaMetrics,
} from '../domain/ports';

/** The eight instruments of S29 AS-57 (R-14). Labels are bounded outcomes only. */
const counters = {
  media_processing_total: MetricsRegistry.counter({
    name: 'media_processing_total',
    help: 'Worker runs by result (ready, rejected, skipped, busy, failed)',
    labels: ['result'],
  }),
  media_duplicate_suspected_total: MetricsRegistry.counter({
    name: 'media_duplicate_suspected_total',
    help: 'Product photos flagged as a possible copy of another shop photo',
    labels: [],
  }),
  media_duplicate_scan_truncated_total: MetricsRegistry.counter({
    name: 'media_duplicate_scan_truncated_total',
    help: 'Band lookups that reached the 500-candidate cap',
    labels: [],
  }),
  media_unknown_key_total: MetricsRegistry.counter({
    name: 'media_unknown_key_total',
    help: 'Queue messages for an original key no photo owns',
    labels: [],
  }),
  media_scan_unavailable_total: MetricsRegistry.counter({
    name: 'media_scan_unavailable_total',
    help: 'Runs that ended because the malware scanner gave no verdict',
    labels: [],
  }),
  media_processing_attempts_exhausted_total: MetricsRegistry.counter({
    name: 'media_processing_attempts_exhausted_total',
    help: 'Photos rejected as processing_failed after the attempt cap',
    labels: [],
  }),
} as const;

const SECONDS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 45, 120];
const histograms = {
  media_processing_seconds: MetricsRegistry.histogram({
    name: 'media_processing_seconds',
    help: 'One worker run, claim to answer',
    labels: ['result'],
    buckets: SECONDS,
  }),
  media_upload_to_ready_seconds: MetricsRegistry.histogram({
    name: 'media_upload_to_ready_seconds',
    help: 'From upload confirmed to READY',
    labels: [],
    buckets: SECONDS,
  }),
} as const;

export const registryMediaMetrics: MediaMetrics = {
  inc(name: MediaMetricName, labels = {}, by = 1) {
    const counter = counters[name as keyof typeof counters];
    if (counter) counter.add(by, labels);
  },
  observe(name: MediaMetricName, value, labels = {}) {
    const histogram = histograms[name as keyof typeof histograms];
    if (histogram) histogram.record(value, labels);
  },
};

/** Structured lines through the Nest logger: `message {json}`; fields come from the port, never from bytes or names. */
export class NestMediaLogger implements MediaLogger {
  private readonly logger = new Logger('Media');
  private line(message: string, fields: MediaLogFields): string {
    return `${message} ${JSON.stringify(fields)}`;
  }
  info(message: string, fields: MediaLogFields) {
    this.logger.log(this.line(message, fields));
  }
  warn(message: string, fields: MediaLogFields) {
    this.logger.warn(this.line(message, fields));
  }
  error(message: string, fields: MediaLogFields) {
    this.logger.error(this.line(message, fields));
  }
}
