const { chromium } = require('/home/zagrava/workspace/personal-projects/portfolio-sandbox/packages/web/node_modules/@playwright/test');
const S = '/tmp/tmp.BhBcbP1uaH';
const B = 'http://localhost:3000';
(async () => {
  const br = await chromium.launch();
  for (const [name, vp] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 390, height: 844 }]]) {
    const ctx = await br.newContext({ viewport: vp });
    const page = await ctx.newPage();
    const errs = [];
    const sugg = [];
    page.on('console', (m) => { if (m.type() === 'error') errs.push(`console@${page.url().replace(B, '')}: ${m.text().slice(0, 120)} loc=${m.location().url}:${m.location().lineNumber}`); });
    page.on('pageerror', (e) => errs.push('pageerror: ' + e.message.slice(0, 200)));
    page.on('request', (r) => { if (/suggest/.test(r.url())) sugg.push(Date.now() + ' ' + r.url().slice(-40)); });
    await page.goto(B + '/', { waitUntil: 'networkidle' });
    // home: typing in search box
    const box = page.getByRole('combobox').first();
    console.log(`[${name}] combobox count`, await page.getByRole('combobox').count());
    await box.click();
    await box.pressSequentially('espre', { delay: 40 });
    await page.waitForTimeout(900);
    console.log(`[${name}] suggest requests while typing 5 chars:`, sugg.length, 'expanded=', await box.getAttribute('aria-expanded'));
    console.log(`[${name}] options:`, await page.getByRole('option').allInnerTexts());
    await page.screenshot({ path: `${S}/${name}-home-suggest.png` });
    await box.press('ArrowDown');
    await box.press('Enter');
    await page.waitForTimeout(1500);
    console.log(`[${name}] after enter url`, page.url().replace(B, ''), 'h1', await page.locator('h1').allInnerTexts());
    // empty submit on /search
    const sb = page.getByRole('combobox').first();
    await sb.fill('');
    await sb.press('Enter');
    await page.waitForTimeout(1200);
    console.log(`[${name}] empty submit ->`, page.url().replace(B, ''), await page.locator('h1').allInnerTexts());
    // very long text
    await sb.fill('x'.repeat(300));
    console.log(`[${name}] long len`, (await sb.inputValue()).length);
    await sb.fill('  desk  ');
    await sb.press('Enter');
    await page.waitForTimeout(1200);
    console.log(`[${name}] trimmed ->`, page.url().replace(B, ''));
    // sort + back/forward
    const sort = page.getByLabel(/sort by/i).first();
    if (await sort.count()) { await sort.selectOption({ index: 2 }).catch((e) => console.log('sort err', e.message.slice(0, 80))); await page.waitForTimeout(1200); console.log(`[${name}] sort ->`, page.url().replace(B, '')); }
    await page.goBack(); await page.waitForTimeout(800); console.log(`[${name}] back ->`, page.url().replace(B, ''));
    await page.goForward(); await page.waitForTimeout(800); console.log(`[${name}] fwd ->`, page.url().replace(B, ''));
    await page.reload({ waitUntil: 'networkidle' }); console.log(`[${name}] reload ->`, page.url().replace(B, ''), 'cards', await page.locator('a[href^="/products/"]').count());
    // price filter
    await page.goto(B + '/search', { waitUntil: 'networkidle' });
    const mn = page.getByLabel(/minimum price/i), mx = page.getByLabel(/maximum price/i);
    await mn.fill('500'); await mx.fill('100');
    await page.getByRole('button', { name: /apply/i }).click(); await page.waitForTimeout(1000);
    console.log(`[${name}] inverted price ->`, page.url().replace(B, ''), 'alerts', await page.getByRole('alert').allInnerTexts());
    await mn.fill('100'); await mx.fill('400');
    await page.getByRole('button', { name: /apply/i }).click(); await page.waitForTimeout(1200);
    console.log(`[${name}] price 100-400 ->`, page.url().replace(B, ''), 'cards', await page.locator('a[href^="/products/"]').count(), 'chips', await page.getByRole('button', { name: /remove|clear/i }).allInnerTexts());
    await page.screenshot({ path: `${S}/${name}-price.png`, fullPage: true });
    // open a product
    await page.goto(B + '/search', { waitUntil: 'networkidle' });
    const clicks = [];
    page.on('request', (r) => { if (/search\/clicks/.test(r.url())) clicks.push(r.postData()); });
    await page.locator('a[href^="/products/"]').first().click();
    await page.waitForLoadState('networkidle');
    console.log(`[${name}] product url`, page.url().replace(B, ''), 'clicks', clicks.length, 'h1', await page.locator('h1').allInnerTexts());
    console.log(`[${name}] product text`, (await page.innerText('body')).replace(/\s+/g, ' ').slice(0, 700));
    await page.screenshot({ path: `${S}/${name}-product.png`, fullPage: true });
    console.log(`[${name}] ERRORS`, [...new Set(errs)]);
    await ctx.close();
  }
  await br.close();
})();
