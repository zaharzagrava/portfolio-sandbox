const { chromium } = require('/home/zagrava/workspace/personal-projects/portfolio-sandbox/packages/web/node_modules/@playwright/test');
const fs = require('fs');
const S = '/tmp/tmp.8jkDSSNS4j/shots/';
const email = `qa${Date.now()}@example.com`;
fs.writeFileSync('/tmp/tmp.8jkDSSNS4j/email.txt', email);
const PW = 'SuperSecurePassword123!';
const txt = async (p, n = 1000) => (await p.innerText('body')).slice(0, n);
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext();
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error' && !/Content Security Policy/.test(m.text())) console.log('CONSOLE', m.text().slice(0, 200)); });
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  page.on('request', r => { if (r.url().includes('search/clicks')) console.log('CLICKREQ', r.postData()); });
  page.on('response', async r => { const u = r.url(); if (/\/api\//.test(u) && !/bff\/session|api\/cart$/.test(u)) { let body = ''; if (r.request().method() !== 'GET' || r.status() >= 400) { try { body = (await r.text()).slice(0, 250); } catch (e) {} } console.log('API', r.status(), r.request().method(), u.replace('http://localhost:3000', ''), body); } });
  await page.goto('http://localhost:3000/search');
  await page.getByText('Mechanical Keyboard Cherry MX Brown').first().click();
  await page.waitForURL(/products/);
  await page.getByRole('button', { name: /add to cart/i }).click();
  await page.waitForTimeout(1200);
  await page.goto('http://localhost:3000/cart');
  await page.waitForTimeout(1200);
  const li = page.locator('li').filter({ hasText: 'Mechanical Keyboard' }).first();
  console.log('LI buttons', await li.locator('button').evaluateAll(els => els.map(e => [e.getAttribute('aria-label'), e.innerText, e.disabled])));
  console.log('LI input', await li.locator('input').evaluateAll(els => els.map(e => [e.getAttribute('aria-label'), e.value])));
  // plus twice
  const btns = li.locator('button');
  const n = await btns.count();
  console.log('count', n);
  await page.screenshot({ path: S + 'cart2.png' });
  await page.getByRole('button', { name: /increase|plus|\+/i }).first().click().catch(e => console.log('no plus by name'));
  await page.waitForTimeout(1000);
  console.log('AFTER', (await page.locator('main').innerText()).replace(/\n+/g, ' | ').slice(0, 400));
  // register
  await page.goto('http://localhost:3000/register');
  console.log('REGISTER', await txt(page, 500));
  console.log('INPUTS', await page.locator('input').evaluateAll(els => els.map(e => [e.name, e.type, e.getAttribute('aria-label')])));
  await b.close();
})();
