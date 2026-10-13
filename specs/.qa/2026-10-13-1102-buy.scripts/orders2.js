const { chromium } = require('/home/zagrava/workspace/personal-projects/portfolio-sandbox/packages/web/node_modules/@playwright/test');
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ storageState: '/tmp/tmp.8jkDSSNS4j/state2.json' });
  const page = await ctx.newPage();
  page.on('response', r => { if (r.request().resourceType() === 'document') console.log('DOC', r.status(), r.url()); });
  await page.goto('http://localhost:3000/checkout/success/01a13485-1245-70c6-b278-0205f7e9a9eb');
  await page.waitForTimeout(1500);
  console.log('LINKS', await page.getByRole('link').evaluateAll(els => els.map(e => [e.innerText.trim(), e.getAttribute('href')])));
  await page.getByRole('link', { name: 'View order' }).click();
  await page.waitForTimeout(2500);
  console.log('AFTER VIEW ORDER', page.url(), (await page.innerText('body')).replace(/\n+/g, ' | ').slice(0, 200));
  await page.screenshot({ path: '/tmp/tmp.8jkDSSNS4j/shots/vieworder.png' });
  for (const u of ['/dashboard/orders', '/orders/01a13485-1245-70c6-b278-0205f7e9a9eb']) {
    await page.goto('http://localhost:3000' + u); await page.waitForTimeout(1500);
    console.log(u, '->', page.url(), (await page.innerText('body')).replace(/\n+/g, ' | ').slice(60, 200));
  }
  await b.close();
})();
