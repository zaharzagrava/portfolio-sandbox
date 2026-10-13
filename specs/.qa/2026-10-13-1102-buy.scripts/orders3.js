const { chromium } = require('/home/zagrava/workspace/personal-projects/portfolio-sandbox/packages/web/node_modules/@playwright/test');
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ storageState: '/tmp/tmp.8jkDSSNS4j/state2.json' });
  const page = await ctx.newPage();
  page.on('response', r => { if (/\/api\//.test(r.url()) && !/session|streams/.test(r.url())) console.log('API', r.status(), r.url().replace('http://localhost:3000', '')); });
  await page.goto('http://localhost:3000/dashboard/orders');
  await page.waitForTimeout(3000);
  console.log((await page.locator('main').first().innerText()).replace(/\n+/g, ' | '));
  await page.screenshot({ path: '/tmp/tmp.8jkDSSNS4j/shots/dash-orders.png' });
  console.log(await page.getByRole('link').evaluateAll(els => els.map(e => [e.innerText.trim().slice(0, 30), e.getAttribute('href')]).filter(x => /order/.test(x[1] || ''))));
  await b.close();
})();
