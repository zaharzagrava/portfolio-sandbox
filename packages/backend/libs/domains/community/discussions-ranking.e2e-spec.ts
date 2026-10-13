import { v4 as uuidv4 } from 'uuid';
import {
  commentThreadPageSchema,
  postPageSchema,
  type PostView,
} from '@marketplace-sandbox/contracts';
import type { TestUser } from '@app/test/utils/catalog-app';
import { sortableId } from './domain/ids';
import { hotScore, wilsonLowerBound } from './domain/ranking';
import {
  createDiscussionsApp,
  type DiscussionsTestApp,
} from './testing/discussions-fixtures';

const DAY = 86_400_000;

describe('Product discussions: hot, top, new, best, paging and cache', () => {
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

  const board = async (query = '', productId = w.product.id) =>
    postPageSchema.parse(
      (
        await t
          .http()
          .get(`/api/boards/${productId}/posts?${query}`)
          .expect(200)
      ).body,
    );
  const ids = (page: { items: Array<{ postId: string }> }) =>
    page.items.map((p) => p.postId);
  const upvote = async (voters: TestUser[], targetId: string, n: number) => {
    for (const voter of voters.slice(0, n))
      await t.vote(voter, targetId, 1).expect(200);
  };
  /** Runs `act` with the clock at `at`, with fresh sessions for `who` (tokens follow the clock). */
  const at = async <T>(
    when: Date,
    who: TestUser[],
    act: () => Promise<T>,
  ): Promise<T> => {
    t.clock.set(when);
    for (const user of who) await t.reauth(user);
    return act();
  };
  const hotKey = (productId = w.product.id) => `dsc:rank:{${productId}}:hot`;

  describe('US4 - hot, top and new', () => {
    it('S25 AS-33: hot weighs votes against age; new is always newest first', async () => {
      const voters = await t.users(20, { aged: true });
      const [a, b] = await t.users(2);
      const o = await t.newPost(a, w.product.id, { title: 'Older with votes' });
      await upvote(voters, o, 20);
      t.clock.advance(3_600_000);
      for (const user of [b, ...voters]) await t.reauth(user);
      const n = await t.newPost(b, w.product.id, {
        title: 'Newer without votes',
      });

      expect(ids(await board('sort=hot'))).toEqual([o, n]);
      expect(ids(await board('sort=new'))).toEqual([n, o]);
      await upvote(voters, n, 20);
      expect(ids(await board('sort=hot'))).toEqual([n, o]);
      expect(ids(await board('sort=new'))).toEqual([n, o]);
    });

    it('S25 AS-34: each post scores by the hot formula to 7 decimals; equal scores order by newer post id first, on every read', async () => {
      const voters = await t.users(6, { aged: true });
      const authors = await t.users(5);
      const posts: Array<{ id: string; ups: number; createdAt: Date }> = [];
      const base = t.clock.now();
      for (const [i, ups] of [3, 0, 6, 1, 3].entries()) {
        const createdAt = new Date(base.getTime() + i * 5 * 3_600_000);
        const id = await at(createdAt, [authors[i]], () =>
          t.newPost(authors[i], w.product.id, { title: `Post ${i}` }),
        );
        posts.push({ id, ups, createdAt });
      }
      await at(new Date(base.getTime() + 30 * 3_600_000), voters, async () => {
        for (const p of posts) await upvote(voters, p.id, p.ups);
      });

      const expected = [...posts]
        .map((p) => ({ ...p, score: hotScore(p.ups, 0, p.createdAt) }))
        .sort((x, y) => y.score - x.score || (x.id < y.id ? 1 : -1));
      const first = ids(await board('sort=hot'));
      expect(first).toEqual(expected.map((p) => p.id));
      for (const p of posts) {
        const stored = await t.redis.zscore(hotKey(), sortableId(p.id));
        expect(
          Math.abs(Number(stored) - hotScore(p.ups, 0, p.createdAt)),
        ).toBeLessThan(5e-8);
      }
      expect(ids(await board('sort=hot'))).toEqual(first);
    });

    it('S25 AS-34: two posts with the same score and the same instant list the newer post id first', async () => {
      const [a, b] = await t.users(2);
      const older = await t.newPost(a, w.product.id, { title: 'First one' });
      const newer = await t.newPost(b, w.product.id, { title: 'Second one' });
      expect(newer > older || newer < older).toBe(true);
      const order = ids(await board('sort=hot'));
      expect(order).toEqual(ids(await board('sort=hot')));
      expect(order[0]).toBe(newer);
      expect(ids(await board('sort=top'))[0]).toBe(newer);
    });

    it.each(['hot', 'top', 'new'])(
      'S25 AS-35: paging %s with limit 2 over five posts gives 2, 2, 1 with no repeat and no gap',
      async (sort) => {
        const voters = await t.users(6, { aged: true });
        const authors = await t.users(5);
        const posts: string[] = [];
        for (const [i, author] of authors.entries()) {
          t.clock.advance(1_000);
          await t.reauth(author);
          posts.push(
            await t.newPost(author, w.product.id, { title: `Post ${i}` }),
          );
        }
        for (const [i, post] of posts.entries()) await upvote(voters, post, i); // 0..4 votes
        const seen: string[] = [];
        const sizes: number[] = [];
        let cursor: string | null = null;
        do {
          const page = await board(
            `sort=${sort}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          );
          sizes.push(page.items.length);
          seen.push(...ids(page));
          cursor = page.nextCursor;
        } while (cursor);
        expect(sizes).toEqual([2, 2, 1]);
        expect(new Set(seen).size).toBe(5);
        expect(new Set(seen)).toEqual(new Set(posts));
      },
    );

    it('S25 AS-35: a vote that moves a post across the cursor leaves no duplicate and no gap for the posts that did not move', async () => {
      const voters = await t.users(8, { aged: true });
      const authors = await t.users(5);
      const posts: string[] = [];
      for (const author of authors)
        posts.push(await t.newPost(author, w.product.id)); // one instant
      for (const [i, post] of posts.entries())
        await upvote(voters, post, 5 - i); // p0 first ... p4 last
      const first = await board('sort=hot&limit=2');
      expect(ids(first)).toEqual([posts[0], posts[1]]);
      await upvote(voters, posts[4], 8); // p4 jumps to the top, across the cursor
      const second = await board(
        `sort=hot&limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`,
      );
      const third = second.nextCursor
        ? await board(
            `sort=hot&limit=2&cursor=${encodeURIComponent(second.nextCursor)}`,
          )
        : { items: [] as PostView[], nextCursor: null };
      for (const page of [second, third])
        expect(new Set(ids(page)).size).toBe(ids(page).length);
      const all = [...ids(first), ...ids(second), ...ids(third)];
      for (const unmoved of posts.slice(0, 4))
        expect(all.filter((id) => id === unmoved)).toHaveLength(1);
    });

    it('S25 AS-36: top windows include a post created exactly one window ago and order by score then newer id', async () => {
      const voters = await t.users(9, { aged: true });
      const authors = await t.users(6);
      const now = new Date(t.clock.now().getTime());
      const cases = [
        { age: 3_600_000, score: 1 },
        { age: 6 * DAY, score: 5 },
        { age: 8 * DAY, score: 9 },
        { age: 40 * DAY, score: 3 },
        { age: 400 * DAY, score: 7 },
        { age: 7 * DAY, score: 2 }, // exactly one week ago
      ];
      const posts = new Map<number, string>();
      for (const [i, c] of cases.entries())
        posts.set(
          c.age,
          await at(new Date(now.getTime() - c.age), [authors[i]], () =>
            t.newPost(authors[i], w.product.id, { title: `Age ${i}` }),
          ),
        );
      await at(now, voters, async () => {
        for (const c of cases) await upvote(voters, posts.get(c.age)!, c.score);
      });
      const names = async (query: string) => ids(await board(query));
      const byScore = (...ages: number[]) =>
        ages
          .map((a) => ({
            id: posts.get(a)!,
            score: cases.find((c) => c.age === a)!.score,
          }))
          .sort((x, y) => y.score - x.score)
          .map((p) => p.id);
      const [h1, d6, d8, d40, d400, d7] = cases.map((c) => c.age);
      expect(await names('sort=top&window=day')).toEqual(byScore(h1));
      expect(await names('sort=top&window=week')).toEqual(byScore(h1, d6, d7));
      expect(await names('sort=top&window=month')).toEqual(
        byScore(h1, d6, d7, d8),
      );
      expect(await names('sort=top&window=year')).toEqual(
        byScore(h1, d6, d7, d8, d40),
      );
      expect(await names('sort=top&window=all')).toEqual(
        byScore(h1, d6, d7, d8, d40, d400),
      );
      expect(await names('sort=top')).toEqual(
        byScore(h1, d6, d7, d8, d40, d400),
      );
    });

    it('S25 AS-37: new reaches every month, 30 months back, with no gap or repeat; an empty board is an empty page', async () => {
      const authors = await t.users(3);
      const now = new Date(t.clock.now().getTime());
      const ages = [0, 62 * DAY, 30 * 31 * DAY];
      const posts: string[] = [];
      for (const [i, age] of ages.entries())
        posts.push(
          await at(new Date(now.getTime() - age), [authors[i]], () =>
            t.newPost(authors[i], w.product.id, { title: `Month ${i}` }),
          ),
        );
      t.clock.set(now);
      expect(ids(await board('sort=new&limit=25'))).toEqual(posts);
      const walked: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await board(
          `sort=new&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        );
        walked.push(...ids(page));
        cursor = page.nextCursor;
      } while (cursor);
      expect(walked).toEqual(posts);
      expect(await board('sort=new', uuidv4())).toEqual({
        items: [],
        nextCursor: null,
      });
    });

    it('S25 AS-38: with the ranking cap at 3, hot and top list only the 3 best and end; new still reaches all 5', async () => {
      t.config.set('discussions_ranking_cap', 3);
      const voters = await t.users(6, { aged: true });
      const authors = await t.users(5);
      const posts: string[] = [];
      for (const author of authors)
        posts.push(await t.newPost(author, w.product.id));
      for (const [i, post] of posts.entries())
        await upvote(voters, post, 5 - i);
      for (const sort of ['hot', 'top']) {
        const page = await board(`sort=${sort}&limit=50`);
        expect(ids(page)).toEqual(posts.slice(0, 3));
        expect(page.nextCursor).toBeNull();
        const paged = await board(`sort=${sort}&limit=2`);
        expect(ids(paged)).toEqual(posts.slice(0, 2));
        const last = await board(
          `sort=${sort}&limit=2&cursor=${encodeURIComponent(paged.nextCursor!)}`,
        );
        expect(ids(last)).toEqual([posts[2]]);
        expect(last.nextCursor).toBeNull();
      }
      expect(new Set(ids(await board('sort=new&limit=50')))).toEqual(
        new Set(posts),
      );
    });

    it('S25 AS-39: bad sort, window, limit and cursor are 400, never a fallback; no parameters mean sort=hot, limit=25', async () => {
      const authors = await t.users(3);
      for (const author of authors)
        for (let i = 0; i < 9; i++)
          await t.newPost(author, w.product.id, {
            title: `Post ${i} of ${author.id.slice(0, 4)}`,
          });
      const bad = [
        'sort=best',
        'sort=',
        'window=week',
        'sort=new&window=day',
        'sort=top&window=decade',
        'limit=0',
        'limit=51',
        'limit=abc',
        'limit=2.5',
        'limit=-1',
      ];
      for (const q of bad) {
        const res = await t
          .http()
          .get(`/api/boards/${w.product.id}/posts?${q}`);
        expect({ q, status: res.status }).toEqual({ q, status: 400 });
        expect(res.body.code).toBe('validation_failed');
      }
      const first = await board('sort=hot&limit=2');
      const token = first.nextCursor!;
      const flipped = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA');
      const otherBoard = (await t.product()).id;
      for (const [q, id] of [
        [`cursor=garbage`, w.product.id],
        [`sort=hot&cursor=${encodeURIComponent(flipped)}`, w.product.id],
        [`sort=hot&cursor=${encodeURIComponent(token)}`, otherBoard],
        [`sort=top&cursor=${encodeURIComponent(token)}`, w.product.id],
        [`sort=new&cursor=${encodeURIComponent(token)}`, w.product.id],
      ] as const) {
        const res = await t
          .http()
          .get(`/api/boards/${id}/posts?${q}`)
          .expect(400);
        expect(res.body.code).toBe('invalid_cursor');
      }
      const defaults = await board('');
      expect(defaults.items).toHaveLength(25);
      expect(defaults.nextCursor).not.toBeNull();
    });

    it('S25 AS-40: an unknown or empty board is an empty page; a deleted post is absent from every list', async () => {
      expect(await board('', uuidv4())).toEqual({
        items: [],
        nextCursor: null,
      });
      const postId = await t.newPost(w.author, w.product.id);
      const other = await t.newPost(w.reader, w.product.id);
      await t.as(w.author).delete(`/api/posts/${postId}`).expect(204);
      for (const sort of ['hot', 'top', 'new'])
        expect(ids(await board(`sort=${sort}`))).toEqual([other]);
      await t.as(w.reader).get(`/api/posts/${postId}`).expect(404);
    });
  });

  describe('US5 - best comments and the first-page cache', () => {
    const thread = async (
      postId: string,
      query = 'sort=best',
      user?: TestUser,
    ) => {
      const req = user
        ? t.as(user).get(`/api/posts/${postId}/comments?${query}`)
        : t.http().get(`/api/posts/${postId}/comments?${query}`);
      return commentThreadPageSchema.parse((await req.expect(200)).body);
    };

    it('S25 AS-42: best ranks by the Wilson bound: 9 up/1 down above 1 up, no votes last; ties older first, stable across pages', async () => {
      const voters = await t.users(10, { aged: true });
      const postId = await t.newPost(w.author, w.product.id);
      const [c1, c2, c3] = await t.users(3);
      const none = await t.newComment(c1, postId, { body: 'no votes' });
      t.clock.advance(1_000);
      const lucky = await t.newComment(c2, postId, { body: 'one up' });
      t.clock.advance(1_000);
      const solid = await t.newComment(c3, postId, {
        body: 'nine up one down',
      });
      await upvote(voters, lucky, 1);
      await upvote(voters, solid, 9);
      await t.vote(voters[9], solid, -1).expect(200);

      const order = (await thread(postId)).items.map((n) => n.commentId);
      expect(order).toEqual([solid, lucky, none]);
      const score = async (id: string) =>
        Number(
          await t.redis.zscore(`dsc:rank:{${postId}}:best`, sortableId(id)),
        );
      expect(
        Math.abs((await score(solid)) - wilsonLowerBound(9, 1)),
      ).toBeLessThan(0.001);
      expect(Math.abs((await score(lucky)) - 0.2065)).toBeLessThan(0.001);
      expect(await score(none)).toBe(0);

      // equal scores: the older comment first, across pages too
      const tied = await t.newPost(w.author, w.product.id, {
        title: 'A tied thread',
      });
      const first = await t.newComment(c1, tied, { body: 'older' });
      t.clock.advance(1_000);
      const second = await t.newComment(c2, tied, { body: 'newer' });
      expect((await thread(tied)).items.map((n) => n.commentId)).toEqual([
        first,
        second,
      ]);
      const paged: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await thread(
          tied,
          `sort=best&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        );
        paged.push(...page.items.map((n) => n.commentId));
        cursor = page.nextCursor;
      } while (cursor);
      expect(paged).toEqual([first, second]);
    });

    it('S25 AS-43: a write drops the cached first page for every reader; votes may lag by at most 5 seconds; the cache holds no viewer data', async () => {
      const voters = await t.users(6, { aged: true });
      const postId = await t.newPost(w.author, w.product.id);
      const [c1, c2, c3] = await t.users(3);
      const a = await t.newComment(c1, postId, { body: 'a' });
      t.clock.advance(1_000);
      const b = await t.newComment(c2, postId, { body: 'b' });
      await upvote(voters, a, 1);

      expect(
        (await thread(postId, 'sort=best', w.reader)).items.map(
          (n) => n.commentId,
        ),
      ).toEqual([a, b]);
      const key = `dsc:page:${postId}:best`;
      const raw = await t.redis.get(key);
      expect(raw).not.toBeNull();
      expect(await t.redis.ttl(key)).toBeGreaterThan(0);
      expect(await t.redis.ttl(key)).toBeLessThanOrEqual(5);
      const cached = JSON.parse(raw!).page.items as Array<{
        myVote: number | null;
        replies: Array<{ myVote: number | null }>;
      }>;
      expect(
        cached.every(
          (n) => n.myVote === null && n.replies.every((r) => r.myVote === null),
        ),
      ).toBe(true);

      // a new comment is visible to the next reader (even anonymous) at once
      const c = await t.newComment(c3, postId, { body: 'c' });
      expect(
        (await thread(postId)).items.map((n) => n.commentId).sort(),
      ).toEqual([a, b, c].sort());

      // votes alone: the cached order may lag for up to 5 s
      await thread(postId);
      await upvote(voters, b, 5);
      t.clock.advance(4_000);
      const lagging = (await thread(postId)).items.map((n) => n.commentId);
      expect(lagging[0]).toBe(a);
      t.clock.advance(2_000);
      expect((await thread(postId)).items.map((n) => n.commentId)[0]).toBe(b);
    });
  });
});
