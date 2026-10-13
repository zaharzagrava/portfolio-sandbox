import { Injectable, Logger } from '@nestjs/common';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import {
  VideoLogger,
  VideoMetrics,
  type VideoLogFields,
  type VideoMetricName,
} from '../domain/video-ports';

/** The seven families of S30 AS-57 (R-21; `video_task_total` carries the nine results). Labels are bounded outcomes only. */
const counters = {
  video_task_total: MetricsRegistry.counter({
    name: 'video_task_total',
    help: 'Task runs by result (done, retry, failed, stale, busy, skipped, timeout)',
    labels: ['task', 'result'],
  }),
  video_status_transitions_total: MetricsRegistry.counter({
    name: 'video_status_transitions_total',
    help: 'Video status transitions',
    labels: ['from', 'to'],
  }),
  video_stuck_recovered_total: MetricsRegistry.counter({
    name: 'video_stuck_recovered_total',
    help: 'Work recovered by the sweep (lease, queued, uploaded, publish, timeout)',
    labels: ['kind'],
  }),
  video_playback_total: MetricsRegistry.counter({
    name: 'video_playback_total',
    help: 'Playback requests by visibility and result',
    labels: ['visibility', 'result'],
  }),
} as const;

const SECONDS = [0.05, 0.25, 1, 5, 20, 60, 180, 600, 1800, 3600, 10800];
const histograms = {
  video_task_seconds: MetricsRegistry.histogram({
    name: 'video_task_seconds',
    help: 'One task run, claim to answer',
    labels: ['task'],
    buckets: SECONDS,
  }),
  video_upload_to_ready_seconds: MetricsRegistry.histogram({
    name: 'video_upload_to_ready_seconds',
    help: 'From upload confirmed to READY',
    labels: [],
    buckets: SECONDS,
  }),
  video_queue_age_seconds: MetricsRegistry.histogram({
    name: 'video_queue_age_seconds',
    help: 'Age of a task message when a worker picks it up',
    labels: [],
    buckets: SECONDS,
  }),
} as const;

@Injectable()
export class RegistryVideoMetrics extends VideoMetrics {
  inc(name: VideoMetricName, labels: Record<string, string> = {}, by = 1) {
    const counter = counters[name as keyof typeof counters];
    if (counter) counter.add(by, labels);
  }
  observe(
    name: VideoMetricName,
    value: number,
    labels: Record<string, string> = {},
  ) {
    const histogram = histograms[name as keyof typeof histograms];
    if (histogram) histogram.record(value, labels);
  }
}

/** Structured lines through the Nest logger: `message {json}`; fields come from the port, never from bytes or names. */
@Injectable()
export class NestVideoLogger extends VideoLogger {
  private readonly logger = new Logger('Video');
  private line(message: string, fields: VideoLogFields): string {
    return `${message} ${JSON.stringify(fields)}`;
  }
  info(message: string, fields: VideoLogFields) {
    this.logger.log(this.line(message, fields));
  }
  warn(message: string, fields: VideoLogFields) {
    this.logger.warn(this.line(message, fields));
  }
  error(message: string, fields: VideoLogFields) {
    this.logger.error(this.line(message, fields));
  }
}
