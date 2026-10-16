import { Logger } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import {
  previewTokenSchema,
  publicStorySchema,
} from '@marketplace-sandbox/contracts';
import { deliver, shopStatusEvent } from './testing/events';
import {
  PREVIEW_SECRET,
  createStoryApp,
  expectContract,
  type Seller,
  type StoryTestApp,
} from './testing/story-client';

const MINUTE = 60_000;

describe('Brand stories: signed preview of drafts', () => {
  let t: StoryTestApp;
  beforeAll(async () => {
    t = await createStoryApp();
  });
  afterAll(async () => {
    await t.close();
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const mint = (s: Seller, storyId: string, locale = 'en') =>
    t.post(s, `/api/shops/${s.shopId}/stories/${storyId}/preview-token`, {
      locale,
    });
  const preview = (token?: string) => {
    const req = t.http().get('/api/stories/preview');
    return token === undefined ? req : req.set('X-Preview-Token', token);
  };
  const withDraft = async () => {
    const s = await t.seller();
    await t.syncShop(s);
    const story = await t.createStory(s);
    await t
      .saveDraft(s, story.id, 'en', {
        title: 'Draft title',
        blocks: [{ type: 'richText', html: '<p>Hi <script>x()</script></p>' }],
      })
      .expect(200);
    return { s, story };
  };
  const sign = (
    claims: object,
    secret = PREVIEW_SECRET,
    options: jwt.SignOptions = {
      algorithm: 'HS256',
      audience: 'story-preview',
      expiresIn: 600,
    },
  ) => jwt.sign(claims, secret, options);

  // ------------------------------------------------------------------------------------------------ AS-60

  it('S27 AS-60: a token is minted for one story, shop and locale, with its own key and a 30-minute life', async () => {
    const { s, story } = await withDraft();
    const res = await mint(s, story.id).expect(200);
    const body = expectContract(previewTokenSchema, res.body);
    expect(body.expiresAt).toBe(
      new Date(t.clock.now().getTime() + 30 * MINUTE).toISOString(),
    );
    const decoded = jwt.verify(body.token, PREVIEW_SECRET, {
      algorithms: ['HS256'],
      audience: 'story-preview',
      clockTimestamp: Math.floor(t.clock.nowMs() / 1_000),
      complete: true,
    });
    expect(decoded.header.alg).toBe('HS256');
    expect(decoded.payload).toMatchObject({
      s: story.id,
      sh: s.shopId,
      l: 'en',
      aud: 'story-preview',
    });
    expect((decoded.payload as { exp: number }).exp).toBe(
      Math.ceil((t.clock.nowMs() + 30 * MINUTE) / 1_000),
    );
    // never the session key
    const sessionKey = t.settings.get('jwt_secret');
    expect(() =>
      jwt.verify(body.token, sessionKey, { algorithms: ['HS256'] }),
    ).toThrow();
  });

  it('S27 AS-60: a viewer is refused, a locale without a draft and a foreign story are 404', async () => {
    const { s, story } = await withDraft();
    const viewer = await t.member(s.shopId, 'VIEWER');
    const denied = await t
      .post(
        viewer,
        `/api/shops/${s.shopId}/stories/${story.id}/preview-token`,
        { locale: 'en' },
      )
      .expect(403);
    expect(denied.body.code).toBe('permission_denied');
    expect((await mint(s, story.id, 'uk').expect(404)).body.code).toBe(
      'draft_not_found',
    );
    const other = await t.seller();
    const foreign = await t.createStory(other);
    expect((await mint(s, foreign.id).expect(404)).body.code).toBe(
      'story_not_found',
    );
    expect((await mint(s, story.id, 'EN_us').expect(400)).body.code).toBe(
      'validation_failed',
    );
  });

  it('S27 AS-60: the token stops working after 30 minutes', async () => {
    const { s, story } = await withDraft();
    const { token } = (await mint(s, story.id).expect(200)).body;
    await preview(token).expect(200);
    await t.advance(29 * MINUTE);
    await preview(token).expect(200);
    await t.advance(2 * MINUTE);
    await preview(token).expect(404);
  });

  // ------------------------------------------------------------------------------------------------ AS-61

  it('S27 AS-61: the preview shows the current draft in the public shape, uncacheable and out of search engines', async () => {
    const { s, story } = await withDraft();
    const { token } = (await mint(s, story.id).expect(200)).body;
    const res = await preview(token).expect(200);
    const body = expectContract(publicStorySchema, res.body);
    expect(body).toMatchObject({
      id: story.id,
      shopId: s.shopId,
      slug: story.slug,
      version: null,
      locale: 'en',
      title: 'Draft title',
      alternates: [],
      preview: true,
      publishedAt: null,
    });
    expect((body.blocks[0] as { html: string }).html).not.toMatch(/script/);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(res.headers.etag).toBeUndefined();
    expect(res.headers['cache-tag']).toBeUndefined();
    // the story was never published
    await t
      .http()
      .get(`/api/stories/${s.shopSlug}/${story.slug}/en`)
      .expect(404);
    // an edit shows at once
    await t.saveDraft(s, story.id, 'en', { title: 'Edited' }, 1).expect(200);
    expect((await preview(token).expect(200)).body.title).toBe('Edited');
  });

  // ------------------------------------------------------------------------------------------------ AS-62

  describe('S27 AS-62: every bad token is the same uncacheable 404', () => {
    let s: Seller;
    let storyId: string;
    let valid: string;
    let claims: { s: string; sh: string; l: string };
    beforeAll(async () => {
      const made = await withDraft();
      s = made.s;
      storyId = made.story.id;
      valid = (await mint(s, storyId).expect(200)).body.token;
      claims = { s: storyId, sh: s.shopId, l: 'en' };
    });

    const expired = () =>
      sign(claims, PREVIEW_SECRET, {
        algorithm: 'HS256',
        audience: 'story-preview',
        expiresIn: -10,
      });
    const none = () => {
      const header = Buffer.from(
        JSON.stringify({ alg: 'none', typ: 'JWT' }),
      ).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          ...claims,
          aud: 'story-preview',
          exp: Math.floor(Date.now() / 1_000) + 600,
        }),
      ).toString('base64url');
      return `${header}.${payload}.`;
    };
    const cases: [string, () => string | undefined][] = [
      ['no header', () => undefined],
      ['a malformed token', () => 'not-a-token'],
      ['a forged signature', () => `${valid.slice(0, -4)}AAAA`],
      ['an expired token', expired],
      [
        'another audience',
        () =>
          sign(claims, PREVIEW_SECRET, {
            algorithm: 'HS256',
            audience: 'something-else',
            expiresIn: 600,
          }),
      ],
      [
        'the session key',
        () => sign(claims, String(t.settings.get('jwt_secret'))),
      ],
      ['alg none', none],
      [
        'another algorithm',
        () =>
          sign(claims, PREVIEW_SECRET, {
            algorithm: 'HS512',
            audience: 'story-preview',
            expiresIn: 600,
          }),
      ],
      [
        'a token for another story',
        () => sign({ ...claims, s: '0192a000-0000-7000-8000-000000000000' }),
      ],
      [
        'a token for another shop',
        () => sign({ ...claims, sh: '0192a000-0000-7000-8000-000000000000' }),
      ],
      [
        'a token for a locale without a draft',
        () => sign({ ...claims, l: 'uk' }),
      ],
      ['a malformed locale claim', () => sign({ ...claims, l: 'EN_us' })],
    ];

    it.each(cases)('rejects %s', async (_name, token) => {
      const reference = await preview('not-a-token').expect(404);
      const res = await preview(token()).expect(404);
      expect(res.body.code).toBe('story_not_found');
      expect({
        type: res.body.type,
        title: res.body.title,
        detail: res.body.detail,
        status: res.body.status,
      }).toEqual({
        type: reference.body.type,
        title: reference.body.title,
        detail: reference.body.detail,
        status: reference.body.status,
      });
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('rejects a valid token in the query string instead of the header', async () => {
      const res = await t
        .http()
        .get(`/api/stories/preview?token=${valid}`)
        .expect(404);
      expect(res.body.code).toBe('story_not_found');
      expect(res.headers['cache-control']).toBe('no-store');
      const alsoParam = await t
        .http()
        .get(`/api/stories/preview?X-Preview-Token=${valid}`)
        .expect(404);
      expect(alsoParam.body.code).toBe('story_not_found');
    });

    it('rejects a token whose story, draft or shop is gone or not active', async () => {
      const made = await withDraft();
      const { token } = (await mint(made.s, made.story.id).expect(200)).body;
      await preview(token).expect(200);
      await deliver(
        t.shopCopy,
        shopStatusEvent(made.s.shopId, 'ACTIVE', 'SUSPENDED', 2),
      );
      expect((await preview(token).expect(404)).headers['cache-control']).toBe(
        'no-store',
      );
      await deliver(
        t.shopCopy,
        shopStatusEvent(made.s.shopId, 'SUSPENDED', 'ACTIVE', 3),
      );
      await preview(token).expect(200);
      await t.rows(`DELETE FROM "StoryDraft" WHERE "storyId" = :id`, {
        id: made.story.id,
      });
      await preview(token).expect(404);

      const gone = await withDraft();
      const goneToken = (await mint(gone.s, gone.story.id).expect(200)).body
        .token;
      await t.rows(`DELETE FROM "StoryDraft" WHERE "storyId" = :id`, {
        id: gone.story.id,
      });
      await t.rows(`DELETE FROM "Story" WHERE "id" = :id`, {
        id: gone.story.id,
      });
      await preview(goneToken).expect(404);
    });

    it('never writes a token to a log line', async () => {
      const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map(
        (level) => jest.spyOn(Logger.prototype, level),
      );
      const stdout = jest.spyOn(process.stdout, 'write');
      await preview(valid).expect(200);
      await preview(expired()).expect(404);
      const lines = [
        ...spies.flatMap((spy) => spy.mock.calls.map((c) => String(c[0]))),
        ...stdout.mock.calls.map((c) => String(c[0])),
      ];
      for (const line of lines) {
        expect(line).not.toContain(valid);
        expect(line).not.toContain(valid.split('.')[2]);
      }
    });
  });
});
