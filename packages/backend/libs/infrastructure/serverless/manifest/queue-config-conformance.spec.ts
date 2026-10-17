import { join } from 'node:path';
import { LAMBDAS } from './lambdas.manifest';
import { expandManifest } from './lambda-spec';
import {
  compareWithManifest,
  parseElasticMqConfig,
  parseTerraformQueues,
  readElasticMqConfig,
  readTerraformQueues,
} from './queue-config-reader';
import { repoRoot } from '../testing';

const root = repoRoot();
const elasticmq = join(root, 'infra/docker/elasticmq/elasticmq.conf');
const terraform = join(root, 'infra/stack/main.tf');
const entries = expandManifest(LAMBDAS);

describe('queue configuration conformance', () => {
  it('S55 AS-29: elasticmq.conf equals the manifest on visibility, receive limit, FIFO flag and dead-letter queue', () => {
    expect(
      compareWithManifest(
        entries,
        readElasticMqConfig(elasticmq),
        'elasticmq.conf',
      ),
    ).toEqual([]);
  });

  it('S55 AS-29: the Terraform queue map equals the manifest on visibility, receive limit and FIFO flag', () => {
    expect(
      compareWithManifest(
        entries,
        readTerraformQueues(terraform),
        'infra/stack/main.tf',
      ),
    ).toEqual([]);
  });

  describe('the check can fail and names file and field', () => {
    const conf = `queues {
  media-processing-dlq {}
  media-processing { defaultVisibilityTimeout = 180 seconds, deadLettersQueue { name = "media-processing-dlq", maxReceiveCount = 3 } }
  "webhook-deliveries-dlq.fifo" { fifo = true }
  "webhook-deliveries.fifo" { fifo = false, defaultVisibilityTimeout = 30 seconds, deadLettersQueue { name = "wrong-dlq", maxReceiveCount = 4 } }
}`;
    const mismatches = compareWithManifest(
      entries,
      parseElasticMqConfig(conf),
      'elasticmq.conf',
    );

    it.each([
      [
        'a wrong visibility',
        'media-processing visibility is 180, manifest media-processing.visibilityTimeoutSec is 360',
      ],
      [
        'a wrong FIFO flag',
        'webhook-deliveries.fifo fifo is false, manifest webhook-delivery.fifo is true',
      ],
      ['a wrong receive limit', 'webhook-deliveries.fifo receive limit is 4'],
      [
        'a wrong dead-letter queue',
        'webhook-deliveries.fifo dead-letter queue is wrong-dlq',
      ],
      [
        'a missing queue',
        'queue "onboarding-documents" (function document-extractor) is missing',
      ],
    ])('reports %s', (_name, fragment) => {
      expect(
        mismatches.some(
          (m) => m.startsWith('elasticmq.conf:') && m.includes(fragment),
        ),
      ).toBe(true);
    });

    it('reports a Terraform entry that is missing', () => {
      const tf = `locals {\n  queues = {\n    "media-processing" = { visibility_seconds = 360, max_receive = 3 }\n  }\n}`;
      const out = compareWithManifest(
        entries,
        parseTerraformQueues(tf),
        'main.tf',
      );
      expect(
        out.some((m) =>
          m.includes(
            '"webhook-deliveries.fifo" (function webhook-delivery) is missing',
          ),
        ),
      ).toBe(true);
    });
  });
});
