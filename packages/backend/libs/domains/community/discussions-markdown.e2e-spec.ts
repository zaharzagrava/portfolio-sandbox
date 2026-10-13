import {
  commentThreadPageSchema,
  postPageSchema,
  postViewSchema,
} from '@marketplace-sandbox/contracts';
import { HTML_POLICY_VERSION } from './domain/content';
import {
  createDiscussionsApp,
  type DiscussionsTestApp,
} from './testing/discussions-fixtures';
import { FORBIDDEN_OUTPUT, XSS_CORPUS } from './testing/xss-corpus';

describe('Product discussions: safe markdown over HTTP', () => {
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

  const clean = (html: string) => {
    for (const forbidden of FORBIDDEN_OUTPUT)
      expect(html).not.toMatch(forbidden);
  };
  const readThread = async (postId: string) =>
    commentThreadPageSchema.parse(
      (await t.http().get(`/api/posts/${postId}/comments?sort=old`).expect(200))
        .body,
    );
  const waitFor = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 40; i++) {
      if (await check()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };

  it('S25 AS-08: one wired post renders only the allow-list: tags, link attributes, headings', async () => {
    const markdown = [
      '# one',
      '## two',
      '### three',
      '#### four',
      '',
      '**b** *i* ~~s~~ `c`',
      '',
      '1. x',
      '2. y',
      '',
      '- p',
      '- q',
      '',
      '> quote',
      '',
      '```',
      'code',
      '```',
      '',
      '[https](https://apple.com) [http](http://x.example) [mail](mailto:a@b.example)',
      '',
      'line one  ',
      'line two',
    ].join('\n');
    const res = await t
      .post(w.author, w.product.id, { body: markdown })
      .expect(201);
    const html: string = postViewSchema.parse(res.body).bodyHtml;
    const tags = new Set(
      [...html.matchAll(/<\/?([a-z0-9]+)/g)].map((m) => m[1]),
    );
    expect(
      [...tags].every((x) =>
        [
          'p',
          'br',
          'strong',
          'em',
          'del',
          'code',
          'pre',
          'blockquote',
          'ul',
          'ol',
          'li',
          'a',
          'h3',
          'h4',
        ].includes(x),
      ),
    ).toBe(true);
    expect(html).toContain('<h4>one</h4>');
    expect(html).toContain('<h4>two</h4>');
    expect(html).toContain('<h3>three</h3>');
    expect(html).toContain('<h4>four</h4>');
    const anchors = [...html.matchAll(/<a ([^>]*)>/g)];
    expect(anchors).toHaveLength(3);
    for (const a of anchors) {
      expect(a[1]).toContain('rel="nofollow ugc noopener noreferrer"');
      expect(a[1]).toContain('target="_blank"');
    }
  });

  it('S25 AS-09: the whole XSS corpus posted as post bodies and comment bodies is accepted, stored raw, and never comes back executable', async () => {
    const writers = await t.users(15, { aged: true });
    const postId = await t.newPost(writers[14], w.product.id, {
      title: 'Host post',
    });
    let n = 0;
    const posted: Array<{ postId: string; markdown: string }> = [];
    const commented: Array<{ commentId: string; markdown: string }> = [];
    for (const [name, markdown] of XSS_CORPUS) {
      const asPost = await t.post(writers[n % 14], w.product.id, {
        title: `Corpus ${name}`,
        body: markdown,
      });
      expect([201]).toContain(asPost.status);
      clean(asPost.body.bodyHtml);
      posted.push({ postId: asPost.body.postId, markdown });
      n++;
      const asComment = await t.comment(writers[n % 14], postId, {
        body: markdown,
      });
      if (markdown.trim() === '') continue;
      expect(asComment.status).toBe(201);
      clean(asComment.body.bodyHtml);
      commented.push({ commentId: asComment.body.commentId, markdown });
      n++;
    }

    for (const { postId: id, markdown } of posted) {
      const stored = (
        await t.cql('SELECT body_md FROM posts WHERE post_id = ?', [id])
      ).first();
      expect(stored.body_md).toBe(markdown);
      clean(
        postViewSchema.parse(
          (await t.http().get(`/api/posts/${id}`).expect(200)).body,
        ).bodyHtml,
      );
    }
    const list = postPageSchema.parse(
      (
        await t
          .http()
          .get(`/api/boards/${w.product.id}/posts?sort=new&limit=50`)
          .expect(200)
      ).body,
    );
    for (const p of list.items) clean(p.bodyHtml);
    const page = await readThread(postId);
    expect(page.items.length).toBeGreaterThan(0);
    for (const node of page.items) clean(node.bodyHtml);
    const stored = new Map(
      (
        await t.cql('SELECT comment_id, body_md FROM comments_by_post')
      ).rows.map((r) => [r.comment_id.toString(), r.body_md as string]),
    );
    for (const { commentId, markdown } of commented)
      expect(stored.get(commentId)).toBe(markdown.trim());
  });

  it('S25 AS-10: an old or unversioned rendition is never served: every route re-renders from the raw markdown and the stored copy is refreshed', async () => {
    const postId = await t.newPost(w.author, w.product.id, {
      body: '**safe**',
    });
    const commentId = await t.newComment(w.reader, postId, {
      body: '*also safe*',
    });
    const evil = '<img src=x onerror=alert(1)>';
    await t.cql(
      'UPDATE posts SET body_html = ?, html_version = 1 WHERE post_id = ?',
      [evil, postId],
    );
    const comment = (
      await t.cql(
        'SELECT bucket, path FROM comment_locator WHERE comment_id = ?',
        [commentId],
      )
    ).first();
    await t.cql(
      'UPDATE comments_by_post SET body_html = ?, html_version = null WHERE post_id = ? AND bucket = ? AND path = ?',
      [evil, postId, comment.bucket, comment.path],
    );

    const one = postViewSchema.parse(
      (await t.http().get(`/api/posts/${postId}`).expect(200)).body,
    );
    expect(one.bodyHtml).toBe('<p><strong>safe</strong></p>');
    const node = (await readThread(postId)).items[0];
    expect(node.bodyHtml).toBe('<p><em>also safe</em></p>');
    clean(one.bodyHtml + node.bodyHtml);

    expect(
      await waitFor(async () => {
        const row = (
          await t.cql(
            'SELECT body_html, html_version FROM posts WHERE post_id = ?',
            [postId],
          )
        ).first();
        return (
          row.html_version === HTML_POLICY_VERSION &&
          row.body_html === '<p><strong>safe</strong></p>'
        );
      }),
    ).toBe(true);
    expect(
      await waitFor(async () => {
        const row = (
          await t.cql(
            'SELECT body_html, html_version FROM comments_by_post WHERE post_id = ? AND bucket = ? AND path = ?',
            [postId, comment.bucket, comment.path],
          )
        ).first();
        return (
          row.html_version === HTML_POLICY_VERSION &&
          row.body_html === '<p><em>also safe</em></p>'
        );
      }),
    ).toBe(true);

    await t.cql(
      'UPDATE posts SET body_html = ?, html_version = 1 WHERE post_id = ?',
      [evil, postId],
    );
    const list = postPageSchema.parse(
      (
        await t
          .http()
          .get(`/api/boards/${w.product.id}/posts?sort=new`)
          .expect(200)
      ).body,
    );
    expect(list.items[0].bodyHtml).toBe('<p><strong>safe</strong></p>');
  });

  it('S25 AS-11: a title with markup comes back byte for byte as JSON text; responses are JSON with nosniff; only bodyHtml carries server markup', async () => {
    const title = '<img src=x onerror=alert(1)>';
    const res = await t
      .post(w.author, w.product.id, { title, body: '**x**' })
      .expect(201);
    expect(res.body.title).toBe(title);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    for (const [key, value] of Object.entries(res.body))
      if (key !== 'bodyHtml' && key !== 'title')
        expect(String(value)).not.toMatch(/</);
    const read = await t
      .http()
      .get(`/api/posts/${res.body.postId}`)
      .expect(200);
    expect(read.body.title).toBe(title);
    expect(read.headers['x-content-type-options']).toBe('nosniff');
    expect(read.headers['content-type']).toContain('application/json');

    const empty = await t
      .comment(w.reader, res.body.postId, { body: '<script></script>' })
      .expect(201);
    expect(empty.body.bodyHtml).toBe('');
    expect(empty.headers['content-type']).toContain('application/json');
    expect(empty.headers['x-content-type-options']).toBe('nosniff');
  });

  it.each([
    ['20,000 nested quote markers', '> '.repeat(20_000)],
    ['5,000 nested list levels', '- '.repeat(5_000)],
  ])(
    'S25 AS-12: %s is refused with 400 markdown_too_complex, fast',
    async (_name, body) => {
      const started = Date.now();
      const res = await t.post(w.author, w.product.id, { body }).expect(400);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(res.body.code).toBe('validation_failed');
      expect(JSON.stringify(res.body.errors)).toContain('markdown_too_complex');
      // a comment is capped at 10,000 characters, so its deep-nesting case is a shorter body
      const nested = body.slice(0, 9_000);
      const comment = await t
        .comment(w.reader, await t.newPost(w.author, w.product.id), {
          body: nested,
        })
        .expect(400);
      expect(JSON.stringify(comment.body.errors)).toContain(
        'markdown_too_complex',
      );
    },
  );

  it('S25 AS-12: 10,000 unclosed bracket pairs and a normal maximum-size body are accepted without a stall', async () => {
    for (const body of [
      '[('.repeat(10_000),
      'Some **bold** words and a [link](https://x.example). '
        .repeat(800)
        .slice(0, 40_000),
    ]) {
      const started = Date.now();
      const res = await t.post(w.author, w.product.id, { body });
      expect(res.status).toBe(201);
      expect(Date.now() - started).toBeLessThan(2_000);
      clean(res.body.bodyHtml);
      t.clock.advance(1_000);
    }
  });
});
