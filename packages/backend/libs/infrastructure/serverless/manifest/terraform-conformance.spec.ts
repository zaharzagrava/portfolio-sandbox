import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../testing';

const root = repoRoot();
const read = (file: string) => readFileSync(join(root, file), 'utf8');
const worker = read('infra/modules/lambda_sqs_worker/main.tf');
const sqs = read('infra/modules/sqs/main.tf');
const stack = read('infra/stack/main.tf');

/** The body of `resource "<type>" "<name>" { ... }` (up to the next top-level closing brace). */
function resource(text: string, type: string, name: string): string {
  const start = text.indexOf(`resource "${type}" "${name}"`);
  if (start < 0) throw new Error(`resource ${type}.${name} not found`);
  const rest = text.slice(start);
  const end = rest.search(/\n\}\n/);
  return end < 0 ? rest : rest.slice(0, end + 2);
}

describe('Terraform deployment properties (AS-37)', () => {
  it('S55 AS-37: every event source mapping reports batch item failures and takes its limits from the manifest', () => {
    const mapping = resource(worker, 'aws_lambda_event_source_mapping', 'sqs');
    expect(mapping).toContain(
      'function_response_types            = ["ReportBatchItemFailures"]',
    );
    expect(mapping).toContain(
      'batch_size                         = each.value.batchSize',
    );
    expect(mapping).toMatch(
      /maximum_concurrency = max\(2, each\.value\.maxConcurrency\)/,
    );
    // the dead-letter handler's mapping reads the DLQ of its source queue (S04 follow-up F-2)
    expect(mapping).toMatch(
      /event_source_arn\s*=\s*local\.consumed_queue_arn\[each\.key\]/,
    );
    expect(worker).toMatch(/deadLetterOf[\s\S]*var\.dlq_arns\[/);
  });

  it('S55 AS-37: each function has its own execution role and a policy for its own queue only', () => {
    expect(resource(worker, 'aws_iam_role', 'fn')).toMatch(
      /for_each\s*=\s*var\.functions/,
    );
    expect(resource(worker, 'aws_iam_role', 'fn')).toContain(
      'marketplace-${var.env}-${each.key}',
    );
    const policy = resource(worker, 'aws_iam_role_policy', 'fn');
    expect(policy).toMatch(/for_each\s*=\s*var\.functions/);
    expect(policy).toMatch(/role\s*=\s*aws_iam_role\.fn\[each\.key\]\.id/);
    expect(policy).toContain('Resource = [local.consumed_queue_arn[each.key]]');
    expect(policy).toContain('var.idempotency_table_arn');
    // no policy lists the queues of all functions any more
    expect(worker).not.toMatch(
      /Resource\s*=\s*\[for f in var\.functions\s*:\s*var\.queue_arns/,
    );
  });

  it('S55 AS-37: a dead-letter handler consumes only its dead-letter queue, a source function never does', () => {
    const local = /consumed_queue_arn\s*=\s*\{[^}]*\}/s.exec(worker)?.[0] ?? '';
    expect(local).toContain(
      'f.deadLetterOf == null ? var.queue_arns[f.queue] : var.dlq_arns[var.functions[f.deadLetterOf].queue]',
    );
  });

  it.each([
    [
      'dlq_depth',
      'ApproximateNumberOfMessagesVisible',
      'threshold           = 0',
    ],
    ['queue_age', 'ApproximateAgeOfOldestMessage', undefined],
    ['throttles', 'Throttles', undefined],
    ['errors', 'Errors', undefined],
  ])('S55 AS-37: alarm %s watches %s', (name, metric, extra) => {
    const alarm = resource(worker, 'aws_cloudwatch_metric_alarm', name);
    expect(alarm).toContain(`metric_name         = "${metric}"`);
    expect(alarm).toContain('alarm_actions       = [var.alarm_topic_arn]');
    if (extra) expect(alarm).toContain(extra);
  });

  it('S55 AS-37: the dead-letter depth alarm is 1 minute on the dead-letter queue', () => {
    const alarm = resource(worker, 'aws_cloudwatch_metric_alarm', 'dlq_depth');
    expect(alarm).toContain('period              = 60');
    expect(alarm).toContain('var.dlq_names[');
    expect(alarm).toContain('GreaterThanThreshold');
  });

  it('S55 AS-37: dead letters are kept 14 days and may be redriven only from their source queue', () => {
    expect(resource(sqs, 'aws_sqs_queue', 'dlq')).toContain(
      'message_retention_seconds = 1209600',
    );
    const allow = resource(sqs, 'aws_sqs_queue_redrive_allow_policy', 'dlq');
    expect(allow).toContain('redrivePermission = "byQueue"');
    expect(allow).toContain(
      'sourceQueueArns   = [aws_sqs_queue.this[each.key].arn]',
    );
  });

  it('S55 AS-37: the SQS module exports the dead-letter ARNs and the stack hands them to the Lambda module', () => {
    expect(sqs).toMatch(/output "dlq_arns"/);
    expect(resource(sqs, 'aws_sqs_queue', 'dlq')).toContain(
      'dlq_visibility_seconds',
    );
    expect(stack).toMatch(/dlq_arns\s*=\s*module\.sqs\.dlq_arns/);
    expect(stack).toMatch(
      /idempotency_table_arn\s*=\s*module\.dynamodb\.table_arns_by_key\["Idempotency"\]/,
    );
  });
});
