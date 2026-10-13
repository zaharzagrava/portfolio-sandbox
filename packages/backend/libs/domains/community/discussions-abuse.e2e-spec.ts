import { Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import {
  commentThreadPageSchema,
  postPageSchema,
  postViewSchema,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import type { TestUser } from '@app/test/utils/catalog-app';
import { Role } from '@app/domains/identity';
import { sortableId } from './domain/ids';
import {
  createDiscussionsApp,
  type DiscussionsTestApp,
} from './testing/discussions-fixtures';

const HOUR = 3_600_000;

describe('Product discussions: abuse controls and moderation', () => {
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

  const board = async (sort: string, user?: TestUser) => {
    const req = user
      ? t.as(user).get(`/api/boards/${w.product.id}/posts?sort=${sort}`)
      : t.http().get(`/api/boards/${w.product.id}/posts?sort=${sort}`);
    return postPageSchema.parse((await req.expect(200)).body);
  };
  const youngVoters = (n: number, ageHours = 1) =>
    Promise.all(Array.from({ length: n }, () => t.agedUser({ ageHours })));
  const weightOf = async (targetId: string, userId: string) =>
    (
      await t.cql(
        'SELECT weight, value FROM votes_by_target WHERE target_id = ? AND user_id = ?',
        [targetId, userId],
      )
    ).first();
  const events = async (type: string) =>
    (await t.cql('SELECT type, payload FROM recorded_events')).rows.filter(
      (e) => e.type === type,
    );
  const ban = (moderator: TestUser, userId: string) =>
    t.as(moderator).put(`/api/moderation/shadow-bans/${userId}`);
  const lift = (moderator: TestUser, userId: string) =>
    t.as(moderator).delete(`/api/moderation/shadow-bans/${userId}`);

  describe('US6 - vote weights', () => {
    it('S25 AS-44: twenty votes from one-hour-old accounts show as 20 but rank below one vote from an old account, in hot and top', async () => {
      const fresh = await youngVoters(20);
      const [oldVoter] = await t.users(1, { aged: true });
      const [a, b] = await t.users(2);
      const A = await t.newPost(a, w.product.id, { title: 'Brigaded post' });
      const B = await t.newPost(b, w.product.id, { title: 'Organic post' });
      for (const voter of fresh) await t.vote(voter, A, 1).expect(200);
      await t.vote(oldVoter, B, 1).expect(200);

      for (const sort of ['hot', 'top']) {
        const page = await board(sort);
        expect(page.items.map((p) => p.postId)).toEqual([B, A]);
        expect(page.items.find((p) => p.postId === A)).toMatchObject({
          ups: 20,
          score: 20,
        });
        expect(page.items.find((p) => p.postId === B)).toMatchObject({
          ups: 1,
          score: 1,
        });
      }
      expect((await weightOf(A, fresh[0].id)).weight).toBe(0);
      expect((await weightOf(B, oldVoter.id)).weight).toBe(1);
    });

    it('S25 AS-44: the weight is fixed when the vote is cast; changing a vote replaces its weight and retracting removes it', async () => {
      const [author] = await t.users(1);
      const [other] = await t.users(1, { aged: true });
      const justYoung = await t.agedUser({ ageHours: 23.9 });
      const post = await t.newPost(author, w.product.id);
      await t.vote(justYoung, post, 1).expect(200);
      expect((await weightOf(post, justYoung.id)).weight).toBe(0);
      const topScore = async () =>
        Number(
          await t.redis.zscore(
            `dsc:rank:{${w.product.id}}:top-all`,
            sortableId(post),
          ),
        );
      await board('top'); // builds the rankings
      expect(await topScore()).toBe(0);

      t.clock.advance(HOUR); // the account is now older than 24 h; the existing vote keeps its weight
      await t.reauth(justYoung);
      await t.reauth(other);
      expect((await weightOf(post, justYoung.id)).weight).toBe(0);
      await t.vote(other, post, 1).expect(200); // an unrelated vote re-scores the post
      expect(await topScore()).toBe(1);

      await t.vote(justYoung, post, -1).expect(200); // a changed vote takes the weight of now
      expect(await weightOf(post, justYoung.id)).toMatchObject({
        weight: 1,
        value: -1,
      });
      expect(await topScore()).toBe(0); // 1 weighted up (other) - 1 weighted down
      const shown = postViewSchema.parse(
        (await t.http().get(`/api/posts/${post}`).expect(200)).body,
      );
      expect(shown).toMatchObject({ ups: 1, downs: 1 });

      await t.vote(justYoung, post, 0).expect(200); // retracting removes the vote and its weight
      expect(await weightOf(post, justYoung.id)).toBeNull();
      expect(await topScore()).toBe(1);
    });

    it('S25 AS-45: when the account lookup fails the vote is recorded with weight 0, answered 200 and a warning is logged', async () => {
      const post = await t.newPost(w.author, w.product.id);
      const warn = jest.spyOn(Logger.prototype, 'warn');
      t.faults.directoryDown = true;
      try {
        const res = await t.vote(w.reader, post, 1).expect(200);
        expect(res.body).toMatchObject({ ups: 1, myVote: 1 });
      } finally {
        t.faults.directoryDown = false;
      }
      expect((await weightOf(post, w.reader.id)).weight).toBe(0);
      expect(
        warn.mock.calls.some(([message]) =>
          String(message).includes('account lookup failed'),
        ),
      ).toBe(true);
      warn.mockRestore();
    });

    it('S25 AS-48: ten zero-weight votes within ten minutes record one anomaly event per hour and a metric; voting is never blocked', async () => {
      const post = await t.newPost(w.author, w.product.id);
      const voters = await youngVoters(16, 0.1);
      const before =
        MetricsRegistry.value('discussions_vote_anomaly_total') ?? 0;
      for (const [i, voter] of voters.entries()) {
        t.clock.advance(10_000);
        await t.vote(voter, post, 1).expect(200);
        expect(await events('discussion.vote_anomaly_detected')).toHaveLength(
          i + 1 >= 10 ? 1 : 0,
        );
      }
      const [event] = await events('discussion.vote_anomaly_detected');
      expect(JSON.parse(event.payload).payload).toMatchObject({
        targetId: post,
        targetType: 'post',
        boardId: w.product.id,
        zeroWeightVotes: 10,
        windowSeconds: 600,
      });
      expect(
        (MetricsRegistry.value('discussions_vote_anomaly_total') ?? 0) - before,
      ).toBe(1);
      expect(
        postViewSchema.parse(
          (await t.http().get(`/api/posts/${post}`).expect(200)).body,
        ).ups,
      ).toBe(16);

      // an hour later another burst signals again
      t.clock.advance(HOUR + 1_000);
      const more = await youngVoters(10, 0.1);
      for (const voter of more) {
        t.clock.advance(5_000);
        await t.vote(voter, post, 1).expect(200);
      }
      expect(await events('discussion.vote_anomaly_detected')).toHaveLength(2);
    });
  });

  describe('US6 - shadow bans', () => {
    it('S25 AS-46: a shadow-banned user sees their own posts and comments and nobody else does; no events, weight 0, counts untouched', async () => {
      const spammer = await t.agedUser();
      await ban(w.moderator, spammer.id).expect(204);

      const spamPost = await t
        .post(spammer, w.product.id, { title: 'Buy my stuff' })
        .expect(201);
      expect(postViewSchema.parse(spamPost.body)).toMatchObject({
        authorId: spammer.id,
        commentCount: 0,
      });
      const realPost = await t.newPost(w.author, w.product.id);
      const spamComment = await t
        .comment(spammer, realPost, { body: 'visit my site' })
        .expect(201);
      expect(spamComment.body).toMatchObject({
        authorId: spammer.id,
        deleted: false,
      });
      const reply = await t
        .comment(spammer, realPost, {
          body: 'again',
          parentId: spamComment.body.commentId,
        })
        .expect(201);
      expect(reply.body.depth).toBe(1);

      for (const sort of ['new', 'hot', 'top']) {
        expect((await board(sort)).items.map((p) => p.postId)).toEqual([
          realPost,
        ]);
        expect(
          (await board(sort, w.reader)).items.map((p) => p.postId),
        ).toEqual([realPost]);
      }
      expect((await board('new', spammer)).items.map((p) => p.postId)).toEqual([
        realPost,
        spamPost.body.postId,
      ]); // created later, same instant: the newer id first
      await t.http().get(`/api/posts/${spamPost.body.postId}`).expect(404);
      await t
        .as(w.reader)
        .get(`/api/posts/${spamPost.body.postId}`)
        .expect(404);
      await t.as(spammer).get(`/api/posts/${spamPost.body.postId}`).expect(200);

      const others = commentThreadPageSchema.parse(
        (
          await t
            .as(w.reader)
            .get(`/api/posts/${realPost}/comments?sort=old`)
            .expect(200)
        ).body,
      );
      expect(others.items).toEqual([]);
      const own = commentThreadPageSchema.parse(
        (
          await t
            .as(spammer)
            .get(`/api/posts/${realPost}/comments?sort=old`)
            .expect(200)
        ).body,
      );
      expect(own.items.map((n) => n.commentId)).toEqual([
        spamComment.body.commentId,
      ]);
      expect(own.items[0].replies.map((r) => r.commentId)).toEqual([
        reply.body.commentId,
      ]);
      expect(
        postViewSchema.parse(
          (await t.http().get(`/api/posts/${realPost}`).expect(200)).body,
        ).commentCount,
      ).toBe(0);

      const shadowReply = await t
        .comment(w.reader, realPost, {
          body: 'to the spam',
          parentId: spamComment.body.commentId,
        })
        .expect(404);
      expect(shadowReply.body.code).toBe('parent_not_found');
      expect(await events('discussion.post_created')).toHaveLength(1); // the real post only
      expect(await events('discussion.comment_created')).toHaveLength(0);

      await t.vote(spammer, realPost, 1).expect(200);
      expect((await weightOf(realPost, spammer.id)).weight).toBe(0);
    });

    it('S25 AS-46: lifting the ban shows new content only; older content stays hidden; both calls repeat as 204', async () => {
      const spammer = await t.agedUser();
      await ban(w.moderator, spammer.id).expect(204);
      await ban(w.moderator, spammer.id).expect(204);
      const hidden = await t.newPost(spammer, w.product.id, {
        title: 'Made while banned',
      });
      await lift(w.moderator, spammer.id).expect(204);
      await lift(w.moderator, spammer.id).expect(204);
      const shown = await t.newPost(spammer, w.product.id, {
        title: 'Made after the ban',
      });
      expect((await board('new')).items.map((p) => p.postId)).toEqual([shown]);
      await t.http().get(`/api/posts/${hidden}`).expect(404);
      expect(await events('discussion.post_created')).toHaveLength(1);
    });

    it('S25 AS-46: only an admin or moderator can ban or lift, and the user must exist', async () => {
      const spammer = await t.agedUser();
      for (const user of [w.reader, w.seller]) {
        const refused = await ban(user, spammer.id).expect(403);
        expect(refused.body.code).toBe('forbidden');
        await lift(user, spammer.id).expect(403);
      }
      const admin = await t.agedUser({ role: Role.ADMIN });
      await ban(admin, spammer.id).expect(204);
      const unknown = await ban(w.moderator, uuidv4()).expect(404);
      expect(unknown.body.code).toBe('user_not_found');
      await lift(w.moderator, uuidv4()).expect(404);
    });
  });
});
