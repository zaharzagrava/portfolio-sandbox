/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';

// Seeds ONE post with a 50,000-comment thread straight into ScyllaDB, in the layout of
// specs/domains/S25-discussions/data-model.md (S25 SC-005): 5,000 top-level comments in partitions of 5,000, each with
// 9 replies stored with its root. Prints BOARD_ID and POST_ID for `discussions.test.js`.
//
//   node scripts/load-tests/seed/discussions-thread.js [--comments 50000] [--board <product uuid>]
//
// Env: CASSANDRA_CONTACT_POINTS (default localhost:9042), CASSANDRA_LOCAL_DC, CASSANDRA_KEYSPACE (default marketplace).
// After seeding, read the first page and one "load more" and compare the rows each read returns with the page size:
// the first page reads at most `limit` roots plus their first 5 replies each, never the rest of the thread.
const path = require('path');
const crypto = require('crypto');
const { Client, types, concurrent } = require(require.resolve('cassandra-driver', { paths: [path.resolve(__dirname, '../../..')] }));

require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > -1 ? process.argv[at + 1] : fallback;
};
const TOTAL = Number(arg('comments', 50000));
const BOARD_ID = arg('board', crypto.randomUUID());
const PARTITION = 5000;
const REPLIES_PER_ROOT = 9;
const AUTHOR = crypto.randomUUID();

/** Same derivation as `domain/paths.ts`: the sortable form of the comment id, without the constant version nibble. */
const segment = (id) => {
  const [tl, tm, th, clock, node] = id.split('-');
  return `${th}${tm}${tl}${clock}${node}`.slice(1);
};

const bucketOf = (date) => date.getUTCFullYear() * 100 + date.getUTCMonth() + 1;

async function main() {
  const client = new Client({
    contactPoints: (process.env.CASSANDRA_CONTACT_POINTS || 'localhost:9042').split(','),
    localDataCenter: process.env.CASSANDRA_LOCAL_DC || 'datacenter1',
    keyspace: process.env.CASSANDRA_KEYSPACE || 'marketplace',
  });
  await client.connect();

  const postId = types.TimeUuid.now().toString();
  const createdAt = new Date();
  const statements = [
    {
      query: 'INSERT INTO posts (post_id, board_id, author_id, title, body_md, body_html, html_version, created_at, deleted, shadow) VALUES (?, ?, ?, ?, ?, ?, 2, ?, false, false)',
      params: [postId, BOARD_ID, AUTHOR, 'Load test thread', 'seeded', '<p>seeded</p>', createdAt],
    },
    {
      query: 'INSERT INTO posts_by_board (board_id, bucket, post_id, author_id, title, shadow, deleted) VALUES (?, ?, ?, ?, ?, false, false)',
      params: [BOARD_ID, bucketOf(createdAt), postId, AUTHOR, 'Load test thread'],
    },
    { query: 'INSERT INTO board_months (board_id, bucket) VALUES (?, ?)', params: [BOARD_ID, bucketOf(createdAt)] },
  ];

  const roots = Math.ceil(TOTAL / (1 + REPLIES_PER_ROOT));
  let written = 0;
  for (let r = 0; r < roots && written < TOTAL; r++) {
    const bucket = Math.floor(r / PARTITION);
    const rootId = types.TimeUuid.now().toString();
    const rootPath = segment(rootId);
    const commentAt = new Date();
    const row = (id, path, parent, depth) => ({
      query: 'INSERT INTO comments_by_post (post_id, bucket, path, comment_id, parent_id, author_id, body_md, body_html, html_version, created_at, deleted, shadow, depth, more_replies) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 2, ?, false, false, ?, ?)',
      params: [postId, bucket, path, id, parent, AUTHOR, `comment ${written}`, `<p>comment ${written}</p>`, commentAt, depth, depth === 0 && REPLIES_PER_ROOT > 5],
    });
    const locator = (id, path, parent, depth) => ({
      query: 'INSERT INTO comment_locator (comment_id, post_id, bucket, path, depth, author_id, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      params: [id, postId, bucket, path, depth, AUTHOR, parent],
    });
    statements.push(row(rootId, rootPath, null, 0), locator(rootId, rootPath, null, 0), {
      query: 'INSERT INTO top_comments_by_post (post_id, bucket, path, comment_id, shadow, deleted, author_id) VALUES (?, ?, ?, ?, false, false, ?)',
      params: [postId, bucket, rootPath, rootId, AUTHOR],
    });
    written++;
    for (let k = 0; k < REPLIES_PER_ROOT && written < TOTAL; k++) {
      const id = types.TimeUuid.now().toString();
      const path = `${rootPath}.${segment(id)}`;
      statements.push(row(id, path, rootId, 1), locator(id, path, rootId, 1));
      written++;
    }
  }
  statements.push({
    query: 'INSERT INTO post_buckets (post_id, bucket, filled) VALUES (?, ?, ?)',
    params: [postId, Math.floor((roots - 1) / PARTITION), ((roots - 1) % PARTITION) + 1],
  });

  const result = await concurrent.executeConcurrent(client, statements, { prepare: true, concurrencyLevel: 128 });
  if (result.errors && result.errors.length) throw result.errors[0];
  await client.shutdown();
  console.log(`seeded ${written} comments (${roots} roots) on post ${postId}`);
  console.log(`BOARD_ID=${BOARD_ID}`);
  console.log(`POST_ID=${postId}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
