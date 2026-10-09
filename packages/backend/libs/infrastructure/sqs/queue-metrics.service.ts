import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import {
  GetQueueAttributesCommand,
  ListQueuesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { metrics } from '@opentelemetry/api';
import { ApiConfigService } from '@app/common/config';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

const POLL_MS = 30_000;

const queueDepth = MetricsRegistry.gauge({
  name: 'task_queue_depth',
  help: 'Approximate messages per task queue and state (visible, in_flight, delayed)',
  labels: ['queue', 'state'],
});

/**
 * Queue depth + oldest-message age as Prometheus gauges (SD-33): the inputs
 * of `DLQNotEmpty` and queue-backlog alerts. In AWS the same numbers come from
 * CloudWatch (alarms in O-03); this keeps local/dev and Grafana on one source.
 * Every worker instance reports the same values - dashboards use max().
 */
@Injectable()
export class QueueMetricsService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(QueueMetricsService.name);
  private readonly client: SQSClient;
  private snapshot = new Map<
    string,
    { visible: number; inFlight: number; delayed: number }
  >();
  private timer?: NodeJS.Timeout;

  constructor(config: ApiConfigService) {
    const endpoint = config.get('sqs_endpoint');
    this.client = new SQSClient({
      region: config.get('aws_region') || 'eu-central-1',
      ...(endpoint && {
        endpoint,
        credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
      }),
    });
    const meter = metrics.getMeter('sqs');
    meter
      .createObservableGauge('sqs_queue_messages', {
        description: 'Approximate messages per queue and state',
      })
      .addCallback((r) => {
        for (const [queue, s] of this.snapshot) {
          const dlq = String(
            queue.endsWith('-dlq') || queue.endsWith('-dlq.fifo'),
          );
          r.observe(s.visible, { queue, state: 'visible', dlq });
          r.observe(s.inFlight, { queue, state: 'in_flight', dlq });
          r.observe(s.delayed, { queue, state: 'delayed', dlq });
        }
      });
  }

  onApplicationBootstrap() {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), POLL_MS);
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  /** Reads every queue's counts once and updates the gauges (also called by specs). */
  async refresh() {
    try {
      // One account/region per environment: every queue it lists is ours.
      const { QueueUrls = [] } = await this.client.send(
        new ListQueuesCommand({}),
      );
      const next = new Map<
        string,
        { visible: number; inFlight: number; delayed: number }
      >();
      for (const url of QueueUrls) {
        const { Attributes: a = {} } = await this.client.send(
          new GetQueueAttributesCommand({
            QueueUrl: url,
            AttributeNames: [
              'ApproximateNumberOfMessages',
              'ApproximateNumberOfMessagesNotVisible',
              'ApproximateNumberOfMessagesDelayed',
            ],
          }),
        );
        const queue = url.split('/').pop()!;
        const counts = {
          visible: Number(a.ApproximateNumberOfMessages ?? 0),
          inFlight: Number(a.ApproximateNumberOfMessagesNotVisible ?? 0),
          delayed: Number(a.ApproximateNumberOfMessagesDelayed ?? 0),
        };
        next.set(queue, counts);
        queueDepth.set(counts.visible, { queue, state: 'visible' });
        queueDepth.set(counts.inFlight, { queue, state: 'in_flight' });
        queueDepth.set(counts.delayed, { queue, state: 'delayed' });
      }
      this.snapshot = next;
    } catch (error) {
      this.logger.warn(`queue metrics poll failed: ${(error as Error).name}`);
    }
  }
}
