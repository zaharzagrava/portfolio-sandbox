import { INestApplication } from '@nestjs/common';
import { v4 } from 'uuid';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { inParallel } from '@app/test/utils/async-helpers';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { DiscussionsModule } from './discussions.module';
import { DiscussionService, boardKey } from './application/discussion.service';
import { VoteService } from './application/vote.service';

/** SD-11 against real ScyllaDB (CQL migrations applied) + Redis. */
describe('Product discussions (e2e)', () => {
  let app: INestApplication;
  let seeds: SeedsService;
  let discussions: DiscussionService;
  let votes: VoteService;
  let redis: RedisService;
  const board = () => `product-${v4()}`;

  beforeAll(async () => {
    const moduleRef = await generateTestingModule(
      [DiscussionsModule, SeedsModule],
      { stores: ['redis', 'cassandra'] },
    );
    app = moduleRef.createNestApplication();
    await app.init();
    seeds = app.get(SeedsService);
    discussions = app.get(DiscussionService);
    votes = app.get(VoteService);
    redis = app.get(RedisService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seeds.clean();
  });

  it('nested replies come back in thread order from one ordered partition read', async () => {
    const post = await discussions.createPost(
      board(),
      v4(),
      'iPhone 17 battery after 3 months',
      'Mine lasts all day.',
    );
    const a = await discussions.addComment(post.postId, v4(), 'first');
    const b = await discussions.addComment(post.postId, v4(), 'second');
    const a1 = await discussions.addComment(
      post.postId,
      v4(),
      'reply to first',
      a.commentId,
    );
    const a1x = await discussions.addComment(
      post.postId,
      v4(),
      'reply to reply',
      a1.commentId,
    );

    const thread = await discussions.thread(post.postId);
    expect(thread.map((c) => c.commentId)).toEqual([
      a.commentId,
      a1.commentId,
      a1x.commentId,
      b.commentId,
    ]);
    expect(thread.map((c) => c.depth)).toEqual([0, 1, 2, 0]);
  });

  it('votes: flipping +1 → -1 moves the score by 2; 100 concurrent voters count exactly 100', async () => {
    const post = await discussions.createPost(
      board(),
      v4(),
      'Is this seller legit?',
      '...',
    );
    const user = v4();
    await votes.vote(user, 'post', post.postId, 1);
    expect(await votes.vote(user, 'post', post.postId, -1)).toMatchObject({
      ups: 0,
      downs: 1,
    });

    const voters = Array.from({ length: 100 }, () => v4());
    await inParallel(100, (i) => votes.vote(voters[i], 'post', post.postId, 1));
    expect(await votes.score(post.postId)).toEqual({ ups: 100, downs: 1 });

    // Durable side: flush to counters, then an exact recount from votes_by_target agrees.
    await votes.flushToCounters();
    expect(await votes.recount(post.postId)).toEqual({ ups: 100, downs: 1 });
  });

  it('a double-clicked vote is applied once', async () => {
    const post = await discussions.createPost(board(), v4(), 'title', 'body');
    const user = v4();
    await inParallel(5, () =>
      votes.vote(user, 'post', post.postId, 1).catch(() => undefined),
    );
    expect(await votes.score(post.postId)).toEqual({ ups: 1, downs: 0 });
  });

  it('hot board: a post that gets votes rises above an older unvoted one; best comments by Wilson score', async () => {
    const b = board();
    const older = await discussions.createPost(b, v4(), 'older', 'x');
    const newer = await discussions.createPost(b, v4(), 'newer', 'y');
    for (let i = 0; i < 20; i++)
      await votes.vote(v4(), 'post', older.postId, 1);
    const hot = await redis.client.zrevrange(boardKey(b, 'hot'), 0, -1);
    expect(hot[0]).toBe(older.postId);
    expect(
      (await discussions.listBoard(b, 'new')).posts.map((p) => p.postId),
    ).toEqual([newer.postId, older.postId]);

    const lucky = await discussions.addComment(
      older.postId,
      v4(),
      'one upvote',
    );
    const solid = await discussions.addComment(
      older.postId,
      v4(),
      '9 up 1 down',
    );
    await votes.vote(v4(), 'comment', lucky.commentId, 1);
    for (let i = 0; i < 9; i++)
      await votes.vote(v4(), 'comment', solid.commentId, 1);
    await votes.vote(v4(), 'comment', solid.commentId, -1);
    expect(
      (await discussions.bestThread(older.postId)).map((c) => c.commentId),
    ).toEqual([solid.commentId, lucky.commentId]);
  });
});
