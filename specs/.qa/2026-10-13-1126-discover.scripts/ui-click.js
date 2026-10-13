const { chromium } = require('/home/zagrava/workspace/personal-projects/portfolio-sandbox/packages/web/node_modules/@playwright/test');
const B = 'http://localhost:3000';
(async () => {
  const br = await chromium.launch();
  const page = await (await br.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  page.on('response', async (r) => {
    if (/search\/clicks|facets=true|bff\/session/.test(r.url())) {
      console.log('RESP', r.status(), r.request().method(), r.url().replace(B, ''), '| req:', (r.request().postData() || '').slice(0, 300), '| body:', (await r.text().catch(() => '')).slice(0, 400));
    }
  });
  await page.goto(B + '/search?q=desk', { waitUntil: 'networkidle' });
  await page.locator('a[href^="/products/"]').first().click();
  await page.waitForURL(/\/products\//, { timeout: 15000 }).catch(() => console.log('no navigation'));
  await page.waitForTimeout(2000);
  console.log('URL', page.url(), 'h1', await page.locator('h1').allInnerTexts());
  console.log((await page.innerText('body')).replace(/\s+/g, ' ').slice(0, 900));
  await page.screenshot({ path: '/tmp/tmp.BhBcbP1uaH/product-desk.png', fullPage: true });
  // home trending card click
  await page.goto(B + '/', { waitUntil: 'networkidle' });
  console.log('HOME', (await page.innerText('body')).replace(/\s+/g, ' ').slice(0, 700));
  await br.close();
})();
