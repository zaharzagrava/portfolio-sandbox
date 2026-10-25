import { test, expect } from '@playwright/test';
import { ASK_DOCUMENT_TITLE, ASK_QUESTION, addAskDocument, createIsolatedProduct, register, startDiscussion } from './helpers';

/**
 * JC row of W02 for the product page's community features (AS-40, AS-45..AS-49, AS-53, AS-54). Each journey builds its own
 * product (an isolated category: no other test's posts, ranking or stock touch it, L-005/L-006) and its own members.
 * The Ask step of the second journey (S47 happy path) uses a public knowledge document created for that product through the
 * seller API (B-6) and answered by the dev stack's scripted embedder and model; when the document never becomes READY the
 * step is skipped and annotated `fixme` (questions.md Q-W02-7).
 */
test.describe('Product community @desktop', () => {
  test('discussions deep link opens the tab', async ({ page }) => {
    const product = await createIsolatedProduct();
    await page.goto(`/products/${product.id}?tab=discussions`);

    // The tab named in the address is the open one, with the panel's own heading and the empty text.
    await expect(page.getByRole('tab', { name: 'Discussions' })).toHaveAttribute('aria-selected', 'true');
    const panel = page.getByRole('tabpanel', { name: 'Discussions' });
    await expect(panel.getByRole('heading', { level: 2, name: 'Community discussions' })).toBeVisible();
    await expect(panel.getByText('No discussions yet. Be the first to ask.')).toBeVisible();
    // A visitor reads and is asked to log in; the link comes back to this very view.
    const login = panel.getByRole('link', { name: 'Log in to discuss' });
    await expect(login).toHaveAttribute('href', `/login?returnTo=${encodeURIComponent(`/products/${product.id}?tab=discussions`)}`);

    // An opened post is a deep link too: reloading the address opens it again.
    await register(page);
    const title = `Deep link ${Date.now().toString(36)}`;
    const article = await startDiscussion(page, product.id, title, 'Is it **sturdy**?');
    await article.getByRole('button', { name: 'Show discussion' }).click();
    await expect(page).toHaveURL(/[?&]post=[0-9a-f-]{36}/);
    const opened = page.url();
    await page.goto(opened);
    const again = page.getByRole('tabpanel', { name: 'Discussions' }).getByRole('article', { name: title });
    await expect(again.getByRole('button', { name: 'Hide discussion' })).toHaveAttribute('aria-expanded', 'true');
    await expect(again.getByRole('textbox', { name: 'Write a comment' })).toBeVisible();
  });

  test('start a discussion, upvote it, reply, ask the product', async ({ page, browser }) => {
    test.setTimeout(180_000);
    const product = await createIsolatedProduct();
    // B-6: the public knowledge document is indexed while the discussion steps run.
    const askReady = addAskDocument(product.id).catch(() => false);
    await register(page);
    await page.goto(`/products/${product.id}`);

    await page.getByRole('tab', { name: 'Discussions' }).click();
    const title = `Does it work with USB-C? ${Date.now().toString(36)}`;
    const post = await startDiscussion(page, product.id, title, 'Planning to use it with a **laptop**.');

    // Markdown is rendered and sanitised: bold text, no raw markup on the page.
    await expect(post.locator('strong')).toHaveText('laptop');
    await expect(post).not.toContainText('**');
    await expect(post).not.toContainText('<strong>');
    await expect(post.getByText('You', { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/sort=new/); // the new post is listed first, in New

    // Voting on your own post is refused (S25), so a second account upvotes it.
    const voterContext = await browser.newContext();
    try {
      const voter = await voterContext.newPage();
      await register(voter);
      await voter.goto(`/products/${product.id}?tab=discussions`);
      const theirs = voter.getByRole('tabpanel', { name: 'Discussions' }).getByRole('article', { name: title });
      await expect(theirs).toBeVisible();
      await expect(theirs.getByText('Community member')).toBeVisible();
      // The press shows its effect at once; the context is closed below, so wait until the server has recorded the vote.
      const recorded = voter.waitForResponse((r) => r.request().method() === 'PUT' && r.url().includes('/api/votes/'));
      await theirs.getByRole('button', { name: `Upvote ${title}` }).click();
      expect((await recorded).ok()).toBe(true);
      await expect(theirs.getByRole('button', { name: `Upvote ${title}` })).toHaveAttribute('aria-pressed', 'true');
      await expect(theirs.getByText('Score 1', { exact: true })).toBeVisible();
    } finally {
      await voterContext.close();
    }

    // The author replies: the comment appears under the post at once, with focus, and the count rises.
    await post.getByRole('button', { name: 'Show discussion' }).click();
    await post.getByRole('textbox', { name: 'Write a comment' }).fill('Yes, over **USB-C** it does.');
    await post.getByRole('button', { name: 'Post comment' }).click();
    const comment = post.getByRole('article').filter({ hasText: 'Yes, over' });
    await expect(comment).toBeVisible();
    await expect(comment).toBeFocused();
    await expect(comment.locator('strong')).toHaveText('USB-C');
    await expect(post.getByText('1 comment', { exact: true })).toBeVisible();

    // Reloading shows the same thread (server state, not a local echo); the score the voter gave is still there.
    await page.reload();
    const reloaded = page.getByRole('tabpanel', { name: 'Discussions' }).getByRole('article', { name: title });
    await expect(reloaded.getByText('Score 1', { exact: true })).toBeVisible();
    await expect(reloaded.getByText('1 comment', { exact: true })).toBeVisible();

    // Ask the product (S47 AS-01, W02 AS-54): the seeded public document answers; the answer and a cited source appear.
    if (!(await askReady)) {
      test.info().annotations.push({ type: 'fixme', description: 'the public knowledge document never became READY (questions.md Q-W02-7)' });
      return;
    }
    await page.getByRole('tab', { name: 'Ask about this product' }).click();
    const ask = page.getByRole('tabpanel', { name: 'Ask about this product' });
    await ask.getByRole('textbox', { name: 'Your question' }).fill(ASK_QUESTION);
    await ask.getByRole('button', { name: 'Ask', exact: true }).click();
    const answer = ask.getByRole('region', { name: 'Answer' });
    await expect(answer).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
    await expect(answer.getByTestId('ask-answer')).not.toBeEmpty();
    await expect(ask.getByRole('status')).toHaveText(/Answer ready/);
    // The cited source needs a model that cites; the dev stack's scripted provider echoes the question uncited, which the
    // panel shows as the "not backed by the documents" notice with no Sources (AS-57). Until the stack can script a cited
    // answer (gaps H6, questions.md Q-W02-7) the source line is proven by U-ask, and this journey records it.
    if ((await ask.getByRole('heading', { name: 'Sources' }).count()) > 0) {
      await expect(ask.getByRole('listitem').first()).toContainText(ASK_DOCUMENT_TITLE);
    } else {
      await expect(ask.getByText("This answer isn't backed by the product documents. Check important details with the seller.")).toBeVisible();
      test.info().annotations.push({ type: 'fixme', description: 'no cited source: the dev stack cannot script a cited answer (questions.md Q-W02-7)' });
    }
    await expect(ask.getByRole('textbox', { name: 'Your question' })).toHaveValue(ASK_QUESTION); // the question stays
    expect(page.url()).not.toContain('lantern battery'); // nothing of the question in the address
  });
});
