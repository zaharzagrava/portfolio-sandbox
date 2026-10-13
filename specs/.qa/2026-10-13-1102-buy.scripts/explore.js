const { chromium } = require('/home/zagrava/workspace/personal-projects/portfolio-sandbox/packages/web/node_modules/@playwright/test');
const S = '/tmp/tmp.8jkDSSNS4j/shots/';
(async () => {
  const b = await chromium.launch();
  const page = await (await b.newContext()).newPage();
  page.on('console', m => { if (['error', 'warning'].includes(m.type())) console.log('CONSOLE', m.type(), m.text().slice(0, 200)); });
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  page.on('response', r => { if (r.status() >= 400) console.log('HTTP', r.status(), r.request().method(), r.url()); });
  await page.goto('http://localhost:3000/');
  await page.screenshot({ path: S + 'home.png' });
  console.log((await page.innerText('body')).slice(0, 800));
  await page.goto('http://localhost:3000/search');
  await page.waitForTimeout(2000);
  console.log('SEARCH', (await page.innerText('body')).slice(0, 800));
  await page.screenshot({ path: S + 'search.png' });
  await b.close();
})();
