import { expect, test, type Page } from '@playwright/test';
import { expectNoSeriousViolations } from './axe';
import { FAKE_LOCATION, createIsolatedProduct, createPickupSeed, register, startDiscussion } from '../helpers';

/**
 * VC rows of W02 for the pickup panel on the product page (AS-41, AS-42, AS-75): the panel's states and the map
 * (side panel at 1280 px, dialog at 390 px) against a product with stock at a point near the fake location.
 */

const mobile = (page: Page) => (page.viewportSize()?.width ?? 1280) < 1024;

test.describe('Product panels layout', () => {
  test.use({ geolocation: FAKE_LOCATION, permissions: ['geolocation'] });

  test('pickup: states', async ({ page }) => {
    const seed = await createPickupSeed();
    test.fixme(!seed, 'the pickup seed did not reach the pickup index (questions.md Q-W02-6)');
    await page.goto(`/products/${seed!.productId}?tab=pickup`);
    const panel = page.getByRole('tabpanel', { name: 'Pickup near me' });
    await expect(panel.getByRole('button', { name: 'Use my location' })).toBeVisible(); // idle: nothing requested yet
    await expectNoSeriousViolations(page);
    await panel.getByRole('button', { name: 'Use my location' }).click();
    const list = panel.getByRole('list', { name: 'Pickup points' });
    await expect(list).toBeVisible();
    await expect(list).toContainText(seed!.pointName);
    await expect(panel.getByRole('combobox', { name: 'Radius' })).toBeVisible();
    await expectNoSeriousViolations(page);
    await expect(list).toHaveScreenshot('pickup-list.png');
  });

  test('pickup map: desktop panel and mobile dialog', async ({ page }) => {
    const seed = await createPickupSeed();
    test.fixme(!seed, 'the pickup seed did not reach the pickup index (questions.md Q-W02-6)');
    await page.goto(`/products/${seed!.productId}?tab=pickup`);
    const panel = page.getByRole('tabpanel', { name: 'Pickup near me' });
    await panel.getByRole('button', { name: 'Use my location' }).click();
    const open = panel.getByRole('button', { name: 'Show map' });
    await open.click();
    const map = page.getByRole(mobile(page) ? 'dialog' : 'region', { name: 'Pickup map' });
    await expect(map).toBeVisible();
    const box = (await map.boundingBox())!;
    if (mobile(page)) expect(box.width).toBeGreaterThan(page.viewportSize()!.width - 40);
    else expect(box.width).toBeLessThan(page.viewportSize()!.width);
    await expect(map.getByRole('button', { name: 'Close' })).toBeVisible();
    await expectNoSeriousViolations(page);
    await map.getByRole('button', { name: 'Close' }).click();
    await expect(map).toBeHidden();
    await expect(open).toBeFocused();
  });
});

/**
 * VC row of W02 for the Discussions tab (AS-46, AS-49, AS-53, AS-75): one readable column; at 1280 px the vote controls are a
 * column left of the title, at 390 px an inline row under it with controls of at least 44 px; the composer is a form inside
 * the panel; the thread shows a comment and its reply. Geometry is asserted from the boxes (the texts carry times and the
 * run's own titles, so there is no pixel baseline), and axe must find nothing serious or critical in any state.
 */
test.describe('Discussions layout', () => {
  test('discussions: desktop column of votes, mobile inline votes; composer; thread', async ({ page }) => {
    const product = await createIsolatedProduct();
    await register(page);
    await page.goto(`/products/${product.id}?tab=discussions`);
    const panel = page.getByRole('tabpanel', { name: 'Discussions' });
    await expect(panel.getByRole('heading', { level: 2, name: 'Community discussions' })).toBeVisible();
    await expect(panel.getByText('No discussions yet. Be the first to ask.')).toBeVisible();
    await expectNoSeriousViolations(page);

    // The composer: a form inside the panel at both widths.
    await panel.getByRole('button', { name: 'Start a discussion' }).click();
    const form = panel.getByRole('form', { name: 'Start a discussion' });
    await expect(form).toBeVisible();
    await expect(form.getByRole('textbox', { name: 'Title' })).toBeFocused();
    if (mobile(page)) {
      for (const control of [form.getByRole('textbox', { name: 'Title' }), form.getByRole('button', { name: 'Post', exact: true }), form.getByRole('button', { name: 'Cancel' })]) {
        expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
      }
    }
    await expectNoSeriousViolations(page);

    const title = `Layout check ${Date.now().toString(36)}`;
    const article = await startDiscussion(page, product.id, title, 'Details with **bold** words.');
    await expect(form).toBeHidden();

    // The votes: a column left of the title on desktop, a row under it on a phone.
    const heading = article.getByRole('heading', { level: 3, name: title });
    const up = article.getByRole('button', { name: `Upvote ${title}` });
    const down = article.getByRole('button', { name: `Downvote ${title}` });
    const [h, u, d] = [(await heading.boundingBox())!, (await up.boundingBox())!, (await down.boundingBox())!];
    if (mobile(page)) {
      expect(u.y).toBeGreaterThanOrEqual(h.y + h.height - 1); // under the title
      expect(Math.abs(u.y - d.y)).toBeLessThan(2); // one row
      expect(u.height).toBeGreaterThanOrEqual(43.5);
      expect(u.width).toBeGreaterThanOrEqual(43.5);
      expect(d.height).toBeGreaterThanOrEqual(43.5);
    } else {
      expect(u.x + u.width).toBeLessThanOrEqual(h.x + 1); // left of the title
      expect(d.y).toBeGreaterThan(u.y + u.height - 1); // stacked
      expect(Math.abs(u.x - d.x)).toBeLessThan(2); // one column
    }
    await expectNoSeriousViolations(page);

    // The thread: a comment and a reply under it.
    await article.getByRole('button', { name: 'Show discussion' }).click();
    await expect(page).toHaveURL(/post=[0-9a-f-]{36}/);
    await article.getByRole('textbox', { name: 'Write a comment' }).fill('First comment');
    await article.getByRole('button', { name: 'Post comment' }).click();
    const comment = article.getByRole('article').filter({ hasText: 'First comment' });
    await expect(comment).toBeVisible();
    await comment.getByRole('button', { name: 'Reply to comment' }).click();
    await comment.getByRole('textbox', { name: 'Write a reply' }).fill('First reply');
    await comment.getByRole('button', { name: 'Post reply' }).click();
    await expect(comment.getByText('First reply')).toBeVisible();
    await expectNoSeriousViolations(page);
    // Nothing in the panel sticks out sideways (the purchase bar fixed at the bottom is the purchase area's, not the panel's).
    const wide = await panel.evaluate((root) => {
      const width = document.documentElement.clientWidth;
      return [...root.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > width + 0.5).map((el) => `${el.tagName} ${Math.round(el.getBoundingClientRect().right)}`);
    });
    expect(wide).toEqual([]);
  });
});

/**
 * VC row of W02 for the Ask tab (AS-54, AS-59, AS-75): one column at every width (the form and the answer share it, at most
 * 45 rem), **Ask** full width and at least 44 px on a phone, the answer a labelled region that is not a live region, and axe
 * clean in the idle, answered and error states. The stream is answered by the test (a cited answer needs a model that cites,
 * which the dev stack cannot script: questions.md Q-W02-7), so the answer text and its screenshot are deterministic.
 */
test.describe('Ask layout', () => {
  const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const source = (n: number, headingPath: string, page: number | null) => ({ n, chunkId: `c${n}`, documentId: `d${n}`, title: 'Lantern manual', headingPath, page });

  test('ask: desktop and mobile', async ({ page }) => {
    const product = await createIsolatedProduct();
    let answered = 0;
    await page.route('**/api/products/*/ask', async (route) => {
      answered += 1;
      if (answered > 1) {
        await route.fulfill({ status: 429, contentType: 'application/problem+json', headers: { 'retry-after': '30' }, body: JSON.stringify({ code: 'assistant_busy' }) });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: [
          frame('sources', { mode: 'hybrid', items: [source(1, 'Battery', 4), source(2, 'Charging > USB-C', null), source(3, 'Care', null)] }),
          frame('text', { t: 'The battery lasts 40 hours on one charge [1].\n' }),
          frame('text', { t: 'It charges over USB-C [2].' }),
          frame('done', { citations: [{ text: 'The battery lasts 40 hours on one charge [1].', sources: [1] }, { text: 'It charges over USB-C [2].', sources: [2] }], grounded: true }),
        ].join(''),
      });
    });
    await page.goto(`/products/${product.id}?tab=ask`);
    const panel = page.getByRole('tabpanel', { name: 'Ask about this product' });
    const field = panel.getByRole('textbox', { name: 'Your question' });
    const button = panel.getByRole('button', { name: 'Ask', exact: true });
    await expect(panel.getByRole('heading', { level: 2, name: 'Ask about this product' })).toBeVisible();
    await expect(panel.getByText("Answers come from this product's documents.")).toBeVisible();
    await expectNoSeriousViolations(page);

    // One column: the field and the button start where the panel's content starts, and never exceed 45 rem.
    const viewport = page.viewportSize()!;
    const f = (await field.boundingBox())!;
    const b = (await button.boundingBox())!;
    expect(f.width).toBeLessThanOrEqual(720 + 1);
    expect(Math.abs(f.x - b.x)).toBeLessThan(2);
    if (mobile(page)) {
      expect(b.width).toBeGreaterThan(viewport.width - 48); // full width
      expect(b.height).toBeGreaterThanOrEqual(43.5);
      expect(f.height).toBeGreaterThanOrEqual(43.5);
    }

    await field.fill('How long does the battery last?');
    await button.click();
    const answer = panel.getByRole('region', { name: 'Answer' });
    await expect(answer).toHaveAttribute('aria-busy', 'false');
    await expect(answer.getByRole('heading', { name: 'Sources' })).toBeVisible();
    await expect(answer.getByRole('listitem')).toHaveText(['[1] Lantern manual › Battery (page 4)', '[2] Lantern manual › Charging › USB-C']);
    // The answer shares the form's column and is not a live region (tokens are not announced one by one).
    const a = (await answer.boundingBox())!;
    expect(Math.abs(a.x - f.x)).toBeLessThan(2);
    expect(a.width).toBeLessThanOrEqual(720 + 1);
    expect(await answer.evaluate((node) => node.closest('[aria-live]') === null && node.querySelector('[aria-live]') === null)).toBe(true);
    await expect(panel.getByRole('status')).toHaveText('Answer ready');
    await expectNoSeriousViolations(page);
    await expect(answer).toHaveScreenshot('ask-answer.png');

    // A request error is one alert beside the form; the question stays.
    await panel.getByRole('button', { name: 'Ask', exact: true }).click();
    await expect(panel.getByRole('alert')).toHaveText(/The assistant is busy right now\. Try again in 30 seconds\./);
    await expect(field).toHaveValue('How long does the battery last?');
    await expectNoSeriousViolations(page);
    const wide = await panel.evaluate((root) => {
      const width = document.documentElement.clientWidth;
      return [...root.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > width + 0.5).map((el) => `${el.tagName} ${Math.round(el.getBoundingClientRect().right)}`);
    });
    expect(wide).toEqual([]);
  });
});

/**
 * VC row of W02 for Share (AS-60, AS-61, AS-75): a popover under the button at 1280 px, a sheet fixed to the bottom edge at
 * 390 px with controls of at least 44 px; the signed-out prompt and the created link are both axe clean. The short link is
 * different every run, so the screenshot masks the field.
 */
test.describe('Share layout', () => {
  async function openShare(page: Page) {
    const dialog = page.getByRole('dialog', { name: 'Share this product' });
    await expect(async () => {
      if (!(await dialog.isVisible())) await page.getByRole('button', { name: 'Share' }).click();
      await expect(dialog).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    return dialog;
  }

  test('share: popover and mobile sheet', async ({ page }) => {
    test.setTimeout(120_000);
    const product = await createIsolatedProduct();
    const viewport = page.viewportSize()!;

    // Signed out: the prompt and its Sign in link.
    await page.goto(`/products/${product.id}`);
    let dialog = await openShare(page);
    await expect(dialog.getByText('Sign in to create a share link.')).toBeVisible();
    await expect(dialog.getByRole('link', { name: 'Sign in' })).toBeVisible();
    await expectNoSeriousViolations(page);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // Signed in: the created link.
    await register(page);
    await page.goto(`/products/${product.id}`);
    const trigger = (await page.getByRole('button', { name: 'Share' }).boundingBox())!; // measured before the sheet makes the page inert
    dialog = await openShare(page);
    const field = dialog.getByRole('textbox', { name: 'Share link' });
    await expect(field).toBeVisible();
    const copy = dialog.getByRole('button', { name: 'Copy link' });
    await expect(copy).toBeVisible();
    await expectNoSeriousViolations(page);

    const box = (await dialog.boundingBox())!;
    if (mobile(page)) {
      // A sheet: fixed to the bottom edge and as wide as the screen; the controls are easy to hit.
      expect(box.width).toBeGreaterThan(viewport.width - 2);
      expect(Math.abs(box.y + box.height - viewport.height)).toBeLessThan(2);
      expect((await copy.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
      expect((await field.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
    } else {
      // A popover: narrow, under the button, left edges aligned.
      expect(box.width).toBeLessThanOrEqual(340);
      expect(box.y).toBeGreaterThanOrEqual(trigger.y + trigger.height - 1);
      expect(Math.abs(box.x - trigger.x)).toBeLessThan(2);
    }
    const wide = await dialog.evaluate((root) => {
      const width = document.documentElement.clientWidth;
      return [...root.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > width + 0.5).map((el) => `${el.tagName} ${Math.round(el.getBoundingClientRect().right)}`);
    });
    expect(wide).toEqual([]);
    await expect(dialog).toHaveScreenshot('share-dialog.png', { mask: [field] });
  });
});
