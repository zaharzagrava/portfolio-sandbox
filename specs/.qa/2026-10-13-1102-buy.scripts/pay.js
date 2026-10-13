// usage: node pay.js <orderId> <normal|reload|double>
const { chromium } = require('/home/zagrava/workspace/personal-projects/portfolio-sandbox/packages/web/node_modules/@playwright/test');
const [orderId, mode = 'normal'] = process.argv.slice(2);
const S = '/tmp/tmp.8jkDSSNS4j/shots/';
const txt = async (p, n = 1000) => (await p.innerText('body')).replace(/\n+/g, ' | ').slice(0, n);
const t0 = Date.now();
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ storageState: '/tmp/tmp.8jkDSSNS4j/state2.json' });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error' && !/Content Security Policy/.test(m.text())) console.log('CONSOLE', m.text().slice(0, 200)); });
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  page.on('response', async r => { const u = r.url(); if (/\/api\//.test(u) && !/bff\/session|api\/cart$|streams/.test(u)) { let body = ''; if (r.request().method() !== 'GET' || r.status() >= 400) { try { body = (await r.text()).slice(0, 250); } catch (e) {} } console.log(((Date.now() - t0) / 1000).toFixed(1), 'API', r.status(), r.request().method(), u.replace('http://localhost:3000', ''), body); } });
  await page.goto('http://localhost:3000/checkout/pay/' + orderId);
  await page.waitForTimeout(1500);
  await page.getByRole('radio').check();
  const pay = page.getByRole('button', { name: /^Pay \$/ });
  if (mode === 'double') await pay.dblclick();
  else await pay.click();
  if (mode === 'reload') { await page.waitForTimeout(300); await page.reload(); }
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(3000);
    const t = await txt(page, 500);
    console.log(((Date.now() - t0) / 1000).toFixed(0) + 's', page.url().replace('http://localhost:3000', ''), t.slice(60, 360));
    if (/Order confirmed|didn.t go through|cancelled/i.test(t)) break;
  }
  await page.screenshot({ path: S + `paid-${mode}.png` });
  await b.close();
})();
