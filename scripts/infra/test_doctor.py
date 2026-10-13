#!/usr/bin/env python3
"""Tests for the static infrastructure doctor: python3 scripts/infra/test_doctor.py (a throwaway project is the fixture)."""
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import doctor  # noqa: E402

ELASTICMQ = """include classpath("application.conf")
queues {
  payments-charge-dlq {}
  payments-charge { defaultVisibilityTimeout = 60 seconds, deadLettersQueue { name = "payments-charge-dlq", maxReceiveCount = 5 } }
  notifications-email-dlq {}
  notifications-email { deadLettersQueue { name = "notifications-email-dlq", maxReceiveCount = 5 } }
  "webhook-deliveries-dlq.fifo" { fifo = true }
  "webhook-deliveries.fifo" { fifo = true, deadLettersQueue { name = "webhook-deliveries-dlq.fifo", maxReceiveCount = 8 } }
}
"""
FILES = {
    'infra/docker/elasticmq/elasticmq.conf': ELASTICMQ,
    'docker-compose.yaml': """services:
  elasticmq:
    image: softwaremill/elasticmq-native:latest
    volumes:
      - ./infra/docker/elasticmq/elasticmq.conf:/opt/elasticmq.conf:ro
  minio-init:
    entrypoint: >
      /usr/bin/mc mb --ignore-existing local/marketplace-media;
""",
    'docker-compose.test.yaml': """services:
  test_elasticmq:
    image: softwaremill/elasticmq-native:latest
    volumes:
      - ./infra/docker/elasticmq/elasticmq.conf:/opt/elasticmq.conf:ro
  test_minio_init:
    entrypoint: >
      /usr/bin/mc mb --ignore-existing local/marketplace-media-test;
""",
    'packages/backend/scripts/init-kafka-topics.sh': 'TOPICS=(\n  "products.events"\n  "payments.dlq"\n)\n',
    'packages/backend/env/showcase.env.example': 'MEDIA_BUCKET=marketplace-media\nSQS_ENDPOINT=http://localhost:9324\n',
    'packages/backend/env/test.env.example': 'MEDIA_BUCKET=marketplace-media-test\n',
    'packages/backend/libs/domains/payments/charge.ts': """
export const CHARGE_QUEUE = 'payments-charge';
// a comment that names queue: 'ghost-queue' and 'ghost.events' must not count
/* export const OLD_QUEUE = 'ghost-two'; */
export const NOTIFICATION_QUEUES = { email: 'notifications-email' } as const;
export const WEBHOOK_QUEUE = 'webhook-deliveries.fifo';
""",
    'packages/backend/libs/domains/payments/events.ts': """
export const PaymentCaptured = defineEvent(
  'payment.captured',
  'products',
  1,
  schema,
);
const url = 'http://localhost:9324/000000000000/'; // not a comment start
""",
    'packages/backend/libs/domains/payments/charge.spec.ts': "const QUEUE_X = 'only-in-a-spec';\n",
    'packages/backend/libs/domains/payments/testing/fake.ts': "const QUEUE_Y = 'only-in-testing';\n",
    'packages/backend/libs/domains/catalog/product.model.ts': "@Table({ tableName: 'Product', timestamps: true })\nclass ProductModel {}\n",
    'packages/backend/libs/domains/identity/sessions.ts': "// uses dynamo\nconst TABLE = 'Auth';\nthis.dynamo.table('Carts');\n",
    'packages/backend/libs/domains/community/posts.ts': "// cassandra\nawait this.cassandra.execute('SELECT * FROM posts WHERE id = ?');\nawait this.cassandra.execute('SELECT now() FROM system.local');\n",
    'packages/backend/libs/domains/media/media.ts': "const bucket = config.get('media_bucket') ?? 'marketplace-media';\n",
    'packages/backend/migrations/001.js': "await queryInterface.createTable('Product', {});\nawait queryInterface.sequelize.query(`CREATE TABLE IF NOT EXISTS \"Ledger\" (id int)`);\n",
    'packages/backend/dynamodb/Auth.json': json.dumps({'TableName': 'Auth'}),
    'packages/backend/dynamodb/Carts.json': json.dumps({'TableName': 'Carts'}),
    'packages/backend/cql/010.cql': 'CREATE TABLE IF NOT EXISTS marketplace.posts (id uuid PRIMARY KEY);\n',
}


def make(root, **override):
    for rel, text in {**FILES, **override}.items():
        if text is None:
            continue
        p = os.path.join(root, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, 'w') as f:
            f.write(text)


def run(root, *args):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        rc = doctor.main(['--root', root, *args])
    return rc, out.getvalue()


class DoctorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_consistent_project_passes_and_lists_everything_it_found(self):
        make(self.root)
        rc, out = run(self.root)
        self.assertEqual(rc, 0, out)
        for needle in ('queue payments-charge ', 'queue notifications-email ', 'queue webhook-deliveries-dlq.fifo', 'topic products.events', 'bucket marketplace-media-test',
                       'table postgres Product', 'table dynamodb Auth', 'table dynamodb Carts', 'table cassandra posts'):
            self.assertIn(needle, out)
        self.assertIn('OK: 0 items missing', out)

    def test_comments_tests_and_test_helpers_are_not_usage(self):
        make(self.root)
        _, out = run(self.root)
        for ghost in ('ghost-queue', 'ghost-two', 'ghost.events', 'only-in-a-spec', 'only-in-testing'):
            self.assertNotIn(ghost, out)

    def test_a_queue_missing_from_elasticmq_fails_and_is_named(self):
        make(self.root, **{'infra/docker/elasticmq/elasticmq.conf': ELASTICMQ.replace(
            '  payments-charge-dlq {}\n  payments-charge { defaultVisibilityTimeout = 60 seconds, deadLettersQueue { name = "payments-charge-dlq", maxReceiveCount = 5 } }\n', '')})
        rc, out = run(self.root)
        self.assertEqual(rc, 1)
        self.assertIn('MISSING queue payments-charge ', out)
        self.assertIn('MISSING queue payments-charge-dlq', out)
        self.assertIn('packages/backend/libs/domains/payments/charge.ts:2', out)   # where it is used
        self.assertIn('FAILED: 2 items missing', out)

    def test_a_queue_without_its_dead_letter_queue_fails(self):
        make(self.root, **{'infra/docker/elasticmq/elasticmq.conf': ELASTICMQ.replace('  notifications-email-dlq {}\n', '')})
        rc, out = run(self.root)
        self.assertEqual(rc, 1)
        self.assertIn('MISSING queue notifications-email-dlq', out)
        self.assertNotIn('MISSING queue notifications-email ', out)

    def test_fifo_dead_letter_queue_name(self):
        self.assertEqual(doctor.dlq_of('webhook-deliveries.fifo'), 'webhook-deliveries-dlq.fifo')
        self.assertEqual(doctor.dlq_of('media-processing'), 'media-processing-dlq')

    def test_a_compose_file_that_does_not_mount_the_config_fails(self):
        make(self.root, **{'docker-compose.test.yaml': FILES['docker-compose.test.yaml'].replace('elasticmq.conf', 'other.conf')})
        rc, out = run(self.root, '--only', 'queues')
        self.assertEqual(rc, 1)
        self.assertIn('MISSING stack docker-compose.test.yaml mounts elasticmq.conf', out)

    def test_a_topic_nobody_creates_fails_unless_the_broker_auto_creates(self):
        make(self.root, **{'packages/backend/libs/domains/payments/more.ts': "export const T = 'orders.events';\n"})
        rc, out = run(self.root, '--only', 'topics')
        self.assertEqual(rc, 1)
        self.assertIn('MISSING topic orders.events', out)
        self.assertIn('packages/backend/libs/domains/payments/more.ts:1', out)
        make(self.root, **{'docker-compose.yaml': FILES['docker-compose.yaml'] + '    command:\n      - --set redpanda.auto_create_topics_enabled=true\n'})
        rc, _ = run(self.root, '--only', 'topics')
        self.assertEqual(rc, 0)

    def test_a_topic_from_an_aggregate_type_is_found(self):
        make(self.root, **{'packages/backend/scripts/init-kafka-topics.sh': 'TOPICS=(\n  "payments.dlq"\n)\n'})
        rc, out = run(self.root, '--only', 'topics')
        self.assertEqual(rc, 1)
        self.assertIn('MISSING topic products.events', out)   # defineEvent('payment.captured', 'products', ...)

    def test_a_bucket_nobody_creates_fails(self):
        make(self.root, **{'packages/backend/env/test.env.example': 'MEDIA_BUCKET=marketplace-media-test2\n'})
        rc, out = run(self.root, '--only', 'buckets')
        self.assertEqual(rc, 1)
        self.assertIn('MISSING bucket marketplace-media-test2', out)
        self.assertIn('docker-compose.test.yaml', out)

    def test_the_bucket_default_in_the_code_must_exist_in_the_dev_stack(self):
        make(self.root, **{'packages/backend/libs/domains/media/media.ts': "const b = config.get('media_bucket') ?? 'marketplace-default';\n"})
        rc, out = run(self.root, '--only', 'buckets')
        self.assertEqual(rc, 1)
        self.assertIn('MISSING bucket marketplace-default', out)

    def test_missing_tables_in_each_store(self):
        make(self.root, **{
            'packages/backend/libs/domains/catalog/other.model.ts': "@Table({ tableName: 'Widget' })\nclass W {}\n",
            'packages/backend/libs/domains/identity/more.ts': "// dynamo\nthis.dynamo.table('Holds');\n",
            'packages/backend/libs/domains/community/more.ts': "// cassandra\nq('INSERT INTO votes_by_user (a) VALUES (?)');\n",
        })
        rc, out = run(self.root, '--only', 'tables', '--missing-only')
        self.assertEqual(rc, 1)
        for name in ('postgres Widget', 'dynamodb Holds', 'cassandra votes_by_user'):
            self.assertIn(f'MISSING table {name}', out)
        self.assertNotIn('postgres Product', out)
        self.assertIn('FAILED: 3 items missing', out)

    def test_system_tables_of_cassandra_are_not_tables_of_the_project(self):
        make(self.root)
        _, out = run(self.root, '--only', 'tables')
        self.assertNotIn('cassandra local', out)

    def test_missing_only_hides_what_is_fine(self):
        make(self.root)
        rc, out = run(self.root, '--missing-only')
        self.assertEqual(rc, 0)
        self.assertNotIn('  OK ', out)
        self.assertIn('queues: ', out)

    def test_unknown_kind_is_a_usage_error(self):
        make(self.root)
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            rc, _ = run(self.root, '--only', 'colours')
        self.assertEqual(rc, 2)

    def test_elasticmq_parser_reads_quoted_and_inline_definitions(self):
        self.assertEqual(doctor.parse_elasticmq(ELASTICMQ), {'payments-charge', 'payments-charge-dlq', 'notifications-email', 'notifications-email-dlq',
                                                              'webhook-deliveries.fifo', 'webhook-deliveries-dlq.fifo'})
        self.assertEqual(doctor.parse_elasticmq('queues {\n a {}\n  # b {}\n c { x = 1 }\n}\nother { d {} }'), {'a', 'c'})

    def test_comment_stripper_keeps_line_numbers_and_urls(self):
        out = doctor.strip_comments("a // x\nb /* y\nz */ c\nu = 'http://h/p'\n")
        self.assertEqual(out.count('\n'), 4)
        self.assertIn("'http://h/p'", out)
        self.assertNotIn('x', out.split('\n')[0].replace('a', ''))


class RealRepositoryTests(unittest.TestCase):
    """The queue registry check of lesson L-002, run on this very repository."""

    def test_every_queue_the_code_uses_is_defined_in_elasticmq(self):
        rc, out = run(doctor.ROOT, '--only', 'queues', '--missing-only')
        self.assertEqual(rc, 0, out)

    def test_the_three_queues_that_stuck_the_payment_are_known_and_defined(self):
        rows = doctor.check_queues(doctor.ROOT)
        ok = {r[1] for r in rows if r[3]}
        for q in ('payments-charge', 'orders-refund-requested', 'tenancy-invite-requested'):
            self.assertIn(q, ok)
            self.assertIn(q + '-dlq', ok)

    def test_the_doctor_runs_on_the_whole_repository(self):
        rows = doctor.run(doctor.ROOT)
        self.assertEqual(set(rows), set(doctor.KINDS))
        self.assertGreater(len(rows['queues']), 20)
        self.assertGreater(len(rows['tables']), 50)


if __name__ == '__main__':
    unittest.main()
