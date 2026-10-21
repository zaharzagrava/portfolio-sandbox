import { v4 as uuidv4 } from 'uuid';
import {
  commentRepliesPageSchema,
  commentThreadPageSchema,
  commentViewSchema,
  postViewSchema,
} from '@marketplace-sandbox/contracts';
import { idTime } from './domain/ids';
import {
  createDiscussionsApp,
  type DiscussionsTestApp,
} from './testing/discussions-fixtures';

describe('Product discussions: nested comments, threads and tombstones', () => {
  let t: DiscussionsTestApp;
  let w: Awaited<ReturnType<DiscussionsTestApp['world']>>;

  beforeAll(async () => {
    t = await createDiscussionsApp();
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    w = await t.world();
  });

  const rows = async (query: string, params: unknown[] = []) =>
    (await t.cql(query, params)).rows;
  const thread = async (
    postId: string,
    query = 'sort=old',
    user = w.reader,
  ) => {
    const res = await t
      .as(user)
      .get(`/api/posts/${postId}/comments?${query}`)
      .expect(200);
    return commentThreadPageSchema.parse(res.body);
  };
  const commentCount = async (postId: string) => {
    const res = await t.http().get(`/api/posts/${postId}`).expect(200);
    return postViewSchema.parse(res.body).commentCount;
  };
  const events = async (type: string) =>
    (await rows('SELECT type, payload FROM recorded_events')).filter(
      (e) => e.type === type,
    );
  const tick = () => t.clock.advance(1_000);

  describe('US2 - create and read comments', () => {
    it('S25 AS-13: a comment and a reply are created with the full view; counts and the event follow', async () => {
      const postId = await t.newPost(w.author, w.product.id);
      const top = await t
        .comment(w.reader, postId, { body: 'Great **question**' })
        .expect(201);
      const comment = commentViewSchema.parse(top.body);
      expect(comment).toMatchObject({
        postId,
        parentId: null,
        depth: 0,
        authorId: w.reader.id,
        bodyHtml: '<p>Great <strong>question</strong></p>',
        ups: 0,
        downs: 0,
        score: 0,
        myVote: 0,
        deleted: false,
        replyCount: 0,
      });
      expect(top.body).not.toHaveProperty('path');
      expect(idTime(comment.commentId).toISOString()).toBe(comment.createdAt);
      expect(await commentCount(postId)).toBe(1);

      const replyRes = await t
        .comment(w.author, postId, {
          body: 'Thanks',
          parentId: comment.commentId,
        })
        .expect(201);
      const reply = commentViewSchema.parse(replyRes.body);
      expect(reply).toMatchObject({
        parentId: comment.commentId,
        depth: 1,
        authorId: w.author.id,
      });
      expect(await commentCount(postId)).toBe(2);
      const page = await thread(postId);
      expect(page.items[0].replyCount).toBe(1);

      const created = await events('discussion.comment_created');
      expect(created).toHaveLength(2);
      const payload = JSON.parse(
        created.find(
          (e) => JSON.parse(e.payload).payload.commentId === reply.commentId,
        )!.payload,
      ).payload;
      expect(payload).toMatchObject({
        postId,
        boardId: w.product.id,
        authorId: w.author.id,
        parentCommentId: comment.commentId,
        parentAuthorId: w.reader.id,
        postAuthorId: w.author.id,
        preview: 'Thanks',
      });
    });

    it('S25 AS-14: threads read in order: sort=old gives [a, b], sort=new gives [b, a], replies stay oldest-first in thread order', async () => {
      const [u1, u2, u3, u4] = await t.users(4);
      const postId = await t.newPost(w.author, w.product.id);
      const a = await t.newComment(u1, postId, { body: 'a' });
      tick();
      const b = await t.newComment(u2, postId, { body: 'b' });
      tick();
      const a1 = await t.newComment(u3, postId, { body: 'a1', parentId: a });
      tick();
      const a1x = await t.newComment(u4, postId, { body: 'a1x', parentId: a1 });

      const old = await thread(postId, 'sort=old');
      expect(old.items.map((n) => n.commentId)).toEqual([a, b]);
      expect(old.items[0].replies.map((r) => r.commentId)).toEqual([a1, a1x]);
      expect(old.items[0].replies.map((r) => r.depth)).toEqual([1, 2]);
      expect(old.items[1].replies).toEqual([]);
      expect(old.items[0].hasMoreReplies).toBe(false);
      const fresh = await thread(postId, 'sort=new');
      expect(fresh.items.map((n) => n.commentId)).toEqual([b, a]);
      expect(fresh.items[1].replies.map((r) => r.commentId)).toEqual([a1, a1x]);
    });

    it('S25 AS-15: reply denials: another post, unknown, deleted parent, depth 8 and a non-uuid parent store nothing', async () => {
      const postId = await t.newPost(w.author, w.product.id);
      const otherPost = await t.newPost(w.author, w.product.id);
      const foreign = await t.newComment(w.reader, otherPost);
      const before = (await rows('SELECT comment_id FROM comment_locator'))
        .length;

      const other = await t
        .comment(w.reader, postId, { parentId: foreign })
        .expect(404);
      expect(other.body.code).toBe('parent_not_found');
      const unknown = await t
        .comment(w.reader, postId, { parentId: uuidv4() })
        .expect(404);
      expect(unknown.body.code).toBe('parent_not_found');
      const notUuid = await t
        .comment(w.reader, postId, { parentId: 'nope' })
        .expect(400);
      expect(notUuid.body.code).toBe('validation_failed');

      const doomed = await t.newComment(w.reader, postId, {
        body: 'to be deleted',
      });
      await t.as(w.reader).delete(`/api/comments/${doomed}`).expect(204);
      const deleted = await t
        .comment(w.author, postId, { parentId: doomed })
        .expect(409);
      expect(deleted.body.code).toBe('parent_deleted');

      // a chain down to the maximum depth of 8 (one user per level: the write limit is per user)
      const chain = await t.users(10);
      let parent: string | undefined;
      for (let depth = 0; depth <= 8; depth++)
        parent = await t.newComment(chain[depth], postId, {
          body: `level ${depth}`,
          parentId: parent,
        });
      const tooDeep = await t
        .comment(chain[9], postId, { parentId: parent })
        .expect(422);
      expect(tooDeep.body.code).toBe('max_depth_exceeded');

      const after = (await rows('SELECT comment_id FROM comment_locator'))
        .length;
      expect(after - before).toBe(1 + 9); // the deleted-then-refused comment and the chain; no refused reply was stored
    });

    it('S25 AS-16: comment denials: unknown or deleted post, closed board, bad body, missing key', async () => {
      const postId = await t.newPost(w.author, w.product.id);
      const unknown = await t.comment(w.reader, uuidv4(), {}).expect(404);
      expect(unknown.body.code).toBe('post_not_found');
      for (const bad of [
        { body: '' },
        { body: '   ' },
        { body: 'x'.repeat(10_001) },
        { body: 12 },
        { body: 'ok', extra: 1 },
      ]) {
        const res = await t.comment(w.reader, postId, bad as never).expect(400);
        expect(res.body.code).toBe('validation_failed');
      }
      const noKey = await t
        .as(w.reader)
        .post(`/api/posts/${postId}/comments`)
        .send({ body: 'no key' })
        .expect(422);
      expect(noKey.body.code).toBe('idempotency_key_required');

      await t
        .sql(`UPDATE "Product" SET "status" = 'ARCHIVED' WHERE "id" = :id`, {
          id: w.product.id,
        })
        .catch(() => undefined);
      const closed = await t.comment(w.reader, postId, {});
      expect(closed.status).toBe(409);
      expect(closed.body.code).toBe('board_closed');

      await t.as(w.author).delete(`/api/posts/${postId}`).expect(204);
      const gone = await t.comment(w.reader, postId, {}).expect(404);
      expect(gone.body.code).toBe('post_not_found');
      expect(await rows('SELECT comment_id FROM comment_locator')).toHaveLength(
        0,
      );
    });

    it('S25 AS-17: replaying a comment key returns the stored comment once; reuse with another body or parent is 422; eight concurrent identical creates make one comment, 20 times', async () => {
      const postId = await t.newPost(w.author, w.product.id);
      const key = uuidv4();
      const first = await t
        .comment(w.reader, postId, { body: 'once' }, key)
        .expect(201);
      const replay = await t
        .comment(w.reader, postId, { body: 'once' }, key)
        .expect(201);
      expect(replay.body).toEqual(first.body);
      expect(await commentCount(postId)).toBe(1);
      const body = await t
        .comment(w.reader, postId, { body: 'different' }, key)
        .expect(422);
      expect(body.body.code).toBe('idempotency_key_reuse');
      const parent = await t
        .comment(
          w.reader,
          postId,
          { body: 'once', parentId: first.body.commentId },
          key,
        )
        .expect(422);
      expect(parent.body.code).toBe('idempotency_key_reuse');

      const users = await t.users(20);
      for (const [round, user] of users.entries()) {
        const k = uuidv4();
        const results = await Promise.all(
          Array.from({ length: 8 }, () =>
            t.comment(user, postId, { body: `race ${round}` }, k),
          ),
        );
        const created = results.filter((r) => r.status === 201);
        expect(created.length).toBeGreaterThanOrEqual(1);
        expect(new Set(created.map((r) => r.body.commentId)).size).toBe(1);
        expect(await commentCount(postId)).toBe(2 + round);
      }
      expect(await rows('SELECT comment_id FROM comment_locator')).toHaveLength(
        21,
      );
    });

    it('S25 AS-18: with partitions of 5, 12 roots with replies page across partition boundaries exactly once, replies stay with their root, and a page reads a bounded number of rows', async () => {
      t.config.set('discussions_partition_size', 5);
      const postId = await t.newPost(w.author, w.product.id);
      const users = await t.users(12);
      const roots: string[] = [];
      const replies = new Map<string, string>();
      for (const user of users) {
        tick();
        const root = await t.newComment(user, postId, {
          body: `root ${roots.length}`,
        });
        roots.push(root);
        tick();
        replies.set(
          root,
          await t.newComment(user, postId, { body: 'a reply', parentId: root }),
        );
      }
      expect(
        [
          ...new Set(
            (await rows('SELECT bucket FROM top_comments_by_post')).map(
              (r) => r.bucket,
            ),
          ),
        ].sort(),
      ).toEqual([0, 1, 2]);
      const stored = await rows(
        'SELECT comment_id, bucket, parent_id FROM comments_by_post',
      );
      const bucketOf = new Map(
        stored.map((r) => [r.comment_id.toString(), r.bucket as number]),
      );
      for (const [root, reply] of replies)
        expect(bucketOf.get(reply)).toBe(bucketOf.get(root));

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        t.resetRowCounts();
        const page = await thread(
          postId,
          `sort=old&limit=4${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        );
        expect(t.rowsRead.get('comments_by_post') ?? 0).toBeLessThanOrEqual(
          4 * 6,
        );
        expect(t.rowsRead.get('top_comments_by_post') ?? 0).toBeLessThanOrEqual(
          4 + 1,
        );
        for (const node of page.items) {
          seen.push(node.commentId);
          expect(node.replies.map((r) => r.commentId)).toEqual([
            replies.get(node.commentId),
          ]);
        }
        cursor = page.nextCursor;
        pages++;
      } while (cursor && pages < 10);
      expect(seen).toEqual(roots);
    });

    it('S25 AS-19: 50 users commenting at one frozen instant get 50 distinct ids, none lost, in a stable order', async () => {
      const postId = await t.newPost(w.author, w.product.id);
      const users = await t.users(50);
      const instant = t.clock.now().toISOString();
      const created = await Promise.all(
        users.map((u) => t.comment(u, postId, { body: 'same instant' })),
      );
      expect(created.map((r) => r.status)).toEqual(Array(50).fill(201));
      const ids = created.map((r) => r.body.commentId as string);
      expect(new Set(ids).size).toBe(50);
      expect(new Set(created.map((r) => r.body.createdAt)).size).toBe(1);
      expect(created[0].body.createdAt).toBe(instant);
      expect(await commentCount(postId)).toBe(50);

      const one = await thread(postId, 'sort=old&limit=50');
      const two = await thread(postId, 'sort=old&limit=50');
      expect(one.items).toHaveLength(50);
      expect(one.items.map((n) => n.commentId)).toEqual(
        two.items.map((n) => n.commentId),
      );
      expect(new Set(one.items.map((n) => n.commentId))).toEqual(new Set(ids));
    });

    it('S25 AS-20: a root with 12 replies embeds 5 and loads the other 7 once, in thread order; bad cursors are 400 invalid_cursor; unknown comment is 404', async () => {
      const postId = await t.newPost(w.author, w.product.id);
      const root = await t.newComment(w.reader, postId, { body: 'root' });
      const other = await t.newComment(w.reader, postId, {
        body: 'another root',
      });
      const users = await t.users(12);
      const replyIds: string[] = [];
      for (const user of users) {
        tick();
        replyIds.push(
          await t.newComment(user, postId, { body: 'reply', parentId: root }),
        );
      }
      const page = await thread(postId, 'sort=old');
      const node = page.items.find((n) => n.commentId === root)!;
      expect(node.replies.map((r) => r.commentId)).toEqual(
        replyIds.slice(0, 5),
      );
      expect(node.hasMoreReplies).toBe(true);
      expect(
        page.items.find((n) => n.commentId === other)!.hasMoreReplies,
      ).toBe(false);

      const more: string[] = [];
      let cursor: string | null = null;
      do {
        const res = await t
          .http()
          .get(
            `/api/comments/${root}/replies?limit=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          )
          .expect(200);
        const parsed = commentRepliesPageSchema.parse(res.body);
        more.push(...parsed.items.map((r) => r.commentId));
        cursor = parsed.nextCursor;
      } while (cursor);
      expect(more).toEqual(replyIds.slice(5));

      const first = commentRepliesPageSchema.parse(
        (
          await t
            .http()
            .get(`/api/comments/${root}/replies?limit=5`)
            .expect(200)
        ).body,
      );
      const token = first.nextCursor!;
      const flipped = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA');
      for (const bad of ['garbage', flipped]) {
        const res = await t
          .http()
          .get(
            `/api/comments/${root}/replies?cursor=${encodeURIComponent(bad)}`,
          )
          .expect(400);
        expect(res.body.code).toBe('invalid_cursor');
      }
      const foreign = await t
        .http()
        .get(
          `/api/comments/${other}/replies?cursor=${encodeURIComponent(token)}`,
        )
        .expect(400);
      expect(foreign.body.code).toBe('invalid_cursor');
      const unknown = await t
        .http()
        .get(`/api/comments/${uuidv4()}/replies`)
        .expect(404);
      expect(unknown.body.code).toBe('comment_not_found');
    });
  });

  describe('US2 - delete comments', () => {
    it('S25 AS-21: the author deletes a comment: 204, a tombstone keeps its position and replies, text and author are erased, the count falls once, one event; repeating changes nothing', async () => {
      const postId = await t.newPost(w.author, w.product.id);
      const [r1, r2] = await t.users(2);
      const c = await t.newComment(w.reader, postId, { body: 'secret words' });
      const rep1 = await t.newComment(r1, postId, { body: 'one', parentId: c });
      tick();
      const rep2 = await t.newComment(r2, postId, { body: 'two', parentId: c });
      expect(await commentCount(postId)).toBe(3);

      await t.as(w.reader).delete(`/api/comments/${c}`).expect(204);
      const page = await thread(postId);
      const node = page.items[0];
      expect(node).toMatchObject({
        commentId: c,
        deleted: true,
        deletedBy: 'author',
        bodyHtml: '',
        authorId: null,
        depth: 0,
        replyCount: 2,
      });
      expect(node.replies.map((r) => r.commentId)).toEqual([rep1, rep2]);
      const stored = (
        await rows(
          'SELECT body_md, body_html, author_id, deleted_by FROM comments_by_post',
        )
      ).find((r) => r.deleted_by === 'author')!;
      expect(stored.body_md).toBeNull();
      expect(stored.body_html).toBeNull();
      expect(stored.author_id).toBeNull();
      expect(await commentCount(postId)).toBe(2);
      expect(await events('discussion.comment_deleted')).toHaveLength(1);

      await t.as(w.reader).delete(`/api/comments/${c}`).expect(204);
      expect(await commentCount(postId)).toBe(2);
      expect(await events('discussion.comment_deleted')).toHaveLength(1);
    });

    it('S25 AS-22: another user is 403, a moderator deletes (deletedBy moderator), a seller of the shop is 403, an unknown comment is 404', async () => {
      const postId = await t.newPost(w.author, w.product.id);
      const c = await t.newComment(w.reader, postId);
      const stranger = (await t.users(1))[0];
      const refused = await t
        .as(stranger)
        .delete(`/api/comments/${c}`)
        .expect(403);
      expect(refused.body.code).toBe('forbidden');
      await t.as(w.seller).delete(`/api/comments/${c}`).expect(403);
      expect(await commentCount(postId)).toBe(1);

      await t.as(w.moderator).delete(`/api/comments/${c}`).expect(204);
      const node = (await thread(postId)).items[0];
      expect(node).toMatchObject({ deleted: true, deletedBy: 'moderator' });
      const unknown = await t
        .as(w.reader)
        .delete(`/api/comments/${uuidv4()}`)
        .expect(404);
      expect(unknown.body.code).toBe('comment_not_found');
    });

    it('S25 AS-23: a reply racing with the delete of its parent ends consistently 20 times: stored under the tombstone or refused, never orphaned, counts follow the rows', async () => {
      const postId = await t.newPost(w.author, w.product.id);
      const people = await t.users(40);
      // The 20 rounds use their own parent and their own two people, so they run side by side.
      const outcomes = await Promise.all(
        Array.from({ length: 20 }, async (_, round) => {
          const owner = people[round];
          const replier = people[20 + round];
          const parent = await t.newComment(owner, postId, {
            body: `parent ${round}`,
          });
          const [deleted, reply] = await Promise.all([
            t.as(owner).delete(`/api/comments/${parent}`),
            t.comment(replier, postId, {
              body: 'racing reply',
              parentId: parent,
            }),
          ]);
          expect(deleted.status).toBe(204);
          expect([201, 409]).toContain(reply.status);
          if (reply.status === 409)
            expect(reply.body.code).toBe('parent_deleted');
          return reply.status === 201;
        }),
      );
      const stored = outcomes.filter(Boolean).length;
      const all = await rows(
        'SELECT comment_id, parent_id, deleted FROM comments_by_post',
      );
      const ids = new Set(all.map((r) => r.comment_id.toString()));
      for (const r of all)
        if (r.parent_id) expect(ids.has(r.parent_id.toString())).toBe(true);
      expect(all.filter((r) => r.parent_id)).toHaveLength(stored);
      const visible = all.filter((r) => !r.deleted).length;
      expect(await commentCount(postId)).toBe(visible);
      expect(visible).toBe(stored);
    });
  });
});
