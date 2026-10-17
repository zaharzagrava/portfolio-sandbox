import { readFileSync } from 'node:fs';
import { dlqQueueName, type ManifestEntry } from './lambda-spec';

/** What one queue file says about one queue. Plain line readers: no HCL or HOCON dependency (research D-9). */
export interface QueueConfig {
  name: string;
  visibilitySec?: number;
  maxReceiveCount?: number;
  fifo: boolean;
  /** Dead-letter queue name as the file spells it (ElasticMQ only; Terraform derives it from the key). */
  dlq?: string;
}

export type QueueConfigMap = Map<string, QueueConfig>;

/** `infra/docker/elasticmq/elasticmq.conf`: lines like `name { defaultVisibilityTimeout = 60 seconds, deadLettersQueue {...} }`. */
export function parseElasticMqConfig(text: string): QueueConfigMap {
  const queues: QueueConfigMap = new Map();
  let inQueues = false;
  for (const line of text.split('\n')) {
    if (/^\s*queues\s*\{\s*$/.test(line)) {
      inQueues = true;
      continue;
    }
    if (!inQueues) continue;
    const match = /^\s*"?([\w.-]+)"?\s*\{(.*)\}\s*$/.exec(line);
    if (!match) continue;
    const [, name, body] = match;
    const visibility = /defaultVisibilityTimeout\s*=\s*(\d+)\s*seconds/.exec(
      body,
    );
    const dead =
      /deadLettersQueue\s*\{[^}]*name\s*=\s*"([^"]+)"[^}]*maxReceiveCount\s*=\s*(\d+)/.exec(
        body,
      );
    queues.set(name, {
      name,
      fifo: /fifo\s*=\s*true/.test(body),
      visibilitySec: visibility ? Number(visibility[1]) : undefined,
      dlq: dead?.[1],
      maxReceiveCount: dead ? Number(dead[2]) : undefined,
    });
  }
  return queues;
}

/**
 * The `queues = { ... }` map of `infra/stack/main.tf`: `"name" = { visibility_seconds = N, max_receive = M, fifo = true }`.
 * The dead-letter queue of each key is `<key>-dlq` (`-dlq.fifo` for FIFO), with `dlq_visibility_seconds` when set.
 */
export function parseTerraformQueues(text: string): QueueConfigMap {
  const queues: QueueConfigMap = new Map();
  const start = text.search(/\bqueues\s*=\s*\{/);
  if (start < 0) return queues;
  for (const line of text.slice(start).split('\n').slice(1)) {
    if (/^\s*\}\s*$/.test(line)) break;
    const match = /^\s*"([\w.-]+)"\s*=\s*\{(.*)\}/.exec(line);
    if (!match) continue;
    const [, name, body] = match;
    const visibility = /visibility_seconds\s*=\s*(\d+)/.exec(body);
    const receive = /max_receive\s*=\s*(\d+)/.exec(body);
    const fifo = /fifo\s*=\s*true/.test(body);
    queues.set(name, {
      name,
      fifo,
      visibilitySec: visibility ? Number(visibility[1]) : undefined,
      maxReceiveCount: receive ? Number(receive[1]) : undefined,
      dlq: dlqQueueName(name),
    });
    const dlqVisibility = /dlq_visibility_seconds\s*=\s*(\d+)/.exec(body);
    queues.set(dlqQueueName(name), {
      name: dlqQueueName(name),
      fifo,
      visibilitySec: dlqVisibility ? Number(dlqVisibility[1]) : undefined,
    });
  }
  return queues;
}

export const readElasticMqConfig = (path: string) =>
  parseElasticMqConfig(readFileSync(path, 'utf8'));
export const readTerraformQueues = (path: string) =>
  parseTerraformQueues(readFileSync(path, 'utf8'));

/** Mismatches between the manifest and one queue file; each message names the file and the field (AS-29). */
export function compareWithManifest(
  entries: ManifestEntry[],
  queues: QueueConfigMap,
  file: string,
): string[] {
  const out: string[] = [];
  for (const e of entries) {
    const q = queues.get(e.queue);
    if (!q) {
      out.push(`${file}: queue "${e.queue}" (function ${e.name}) is missing`);
      continue;
    }
    const isDlq = e.deadLetterOf !== undefined;
    if (q.visibilitySec !== e.visibilityTimeoutSec)
      out.push(
        `${file}: ${e.queue} visibility is ${q.visibilitySec}, manifest ${e.name}.visibilityTimeoutSec is ${e.visibilityTimeoutSec}`,
      );
    if (q.fifo !== e.fifo)
      out.push(
        `${file}: ${e.queue} fifo is ${q.fifo}, manifest ${e.name}.fifo is ${e.fifo}`,
      );
    if (isDlq) continue; // a dead-letter queue has no receive limit or dead-letter queue of its own
    if (q.maxReceiveCount !== e.maxReceiveCount)
      out.push(
        `${file}: ${e.queue} receive limit is ${q.maxReceiveCount}, manifest ${e.name}.maxReceiveCount is ${e.maxReceiveCount}`,
      );
    if (q.dlq !== dlqQueueName(e.queue))
      out.push(
        `${file}: ${e.queue} dead-letter queue is ${q.dlq}, expected ${dlqQueueName(e.queue)}`,
      );
  }
  return out;
}
