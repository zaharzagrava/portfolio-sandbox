const { chromium } = require('/home/zagrava/workspace/personal-projects/portfolio-sandbox/packages/web/node_modules/@playwright/test');
const S = '/tmp/tmp.BhBcbP1uaH';
const B = 'http://localhost:3000';
(async () => {
  const br = await chromium.launch();
  for (const [name, vp] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 390, height: 844 }]]) {
    const ctx = await br.newContext({ viewport: vp });
    const page = await ctx.newPage();
    const errs = [];
    page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200)); });
    page.on('pageerror', (e) => errs.push('pageerror: ' + e.message.slice(0, 200)));
    page.on('requestfailed', (r) => errs.push('reqfailed: ' + r.url() + ' ' + (r.failure() || {}).errorText));
    page.on('response', (r) => { if (r.status() >= 500) errs.push('5xx: ' + r.status() + ' ' + r.url()); });
    const visit = async (path, tag) => {
      const t = Date.now();
      const resp = await page.goto(B + path, { waitUntil: 'networkidle', timeout: 40000 }).catch((e) => ({ status: () => 'ERR ' + e.message.slice(0, 80) }));
      await page.screenshot({ path: `${S}/${name}-${tag}.png`, fullPage: true });
      const txt = (await page.innerText('body').catch(() => '')).replace(/\s+/g, ' ');
      console.log(`[${name}] ${path.slice(0, 80)} -> ${resp.status()} ${Date.now() - t}ms url=${page.url().replace(B, '')}\n   h1=${await page.locator('h1').allInnerTexts()} cards=${await page.locator('a[href^="/products/"]').count()}\n   ${txt.slice(0, 350)}`);
    };
    await visit('/', 'home');
    await visit('/search', 'search');
    await visit('/search?q=espresso', 'q-espresso');
    await visit('/search?q=espreso', 'q-typo');
    await visit('/search?q=zzzzqq', 'q-none');
    await visit('/search?q=' + encodeURIComponent('<script>alert(1)</script> "*'), 'q-special');
    await visit('/search?q=' + 'a'.repeat(150), 'q-long');
    await visit('/search?page=99&sort=bogus&foo=bar&cursor=zzz', 'q-junk');
    await visit('/search?sort=price-asc', 'sort-price');
    await visit('/search?semantic=true&q=desk', 'semantic');
    await visit('/search?category=electronics', 'cat');
    await visit('/search?minPrice=500&maxPrice=100', 'price-inverted');
    await visit('/p/00000000-0000-0000-0000-000000000000', 'short-bad');
    await visit('/products/00000000-0000-0000-0000-000000000000', 'prod-404');
    await visit('/products/not-a-uuid', 'prod-bad');
    console.log(`[${name}] ERRORS:`, errs.length ? '\n  ' + [...new Set(errs)].join('\n  ') : 'none');
    await ctx.close();
  }
  await br.close();
})();
