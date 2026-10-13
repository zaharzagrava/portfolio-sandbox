// usage: node buy.js <mode>   mode = normal | reload | double
const { chromium } = require('/home/zagrava/workspace/personal-projects/portfolio-sandbox/packages/web/node_modules/@playwright/test');
const mode = process.argv[2] || 'normal';
const S = '/tmp/tmp.HuYqr45gbw/';
const email = `qa-${mode}-${Date.now()}@example.com`;
const pw = 'SuperSecurePassword123!';
let csp = 0;
const log = (...a) => console.log(...a);
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  p.on('console', (m) => { if (m.type() === 'error') { if (/Content Security Policy/.test(m.text())) csp++; else log('CONSOLE', m.text().slice(0, 200)); } });
  p.on('pageerror', (e) => log('PAGEERR', e.message));
  p.on('response', (r) => { const u = r.url(); if (/\/api\//.test(u)) log('API', r.request().method(), r.status(), u.replace('http://localhost:3000', '')); });
  const shot = (n) => p.screenshot({ path: `${S}${mode}-${n}.png`, fullPage: true });
  const body = async () => (await p.innerText('body')).replace(/\n+/g, ' | ').slice(0, 700);

  await p.goto('http://localhost:3000/');
  await p.getByRole('link', { name: /Mechanical Keyboard/ }).first().click();
  await p.waitForURL(/products\//);
  log('PRODUCT', await body());
  await p.getByRole('button', { name: /Add to cart/i }).click();
  await p.waitForTimeout(1500);
  log('AFTER ADD', await body());
  await shot('1-added');
  await p.goto('http://localhost:3000/cart');
  await p.waitForTimeout(1500);
  log('CART', await body());
  const plus = p.getByRole('button', { name: /increase|\+/i }).first();
  await plus.click(); await p.waitForTimeout(1000);
  await plus.click(); await p.waitForTimeout(1500);
  log('CART qty3', await body());
  await shot('2-cart');
  await p.getByRole('link', { name: /sign in to check out/i }).or(p.getByRole('button', { name: /sign in to check out/i })).first().click();
  await p.waitForTimeout(1500);
  log('LOGIN URL', p.url());
  await p.getByRole('link', { name: /sign up|register|create/i }).first().click();
  await p.waitForTimeout(1000);
  log('REGISTER', p.url(), await body());
  await shot('3-register');
  await p.getByLabel(/email/i).first().fill(email);
  const pws = p.locator('input[type=password]:visible');
  for (let i = 0; i < await pws.count(); i++) await pws.nth(i).fill(pw);
  const nm = p.getByLabel(/name/i); if (await nm.count()) await nm.first().fill('QA Buyer');
  const tos = p.getByRole('checkbox'); for (let i = 0; i < await tos.count(); i++) await tos.nth(i).check();
  await p.getByRole('button', { name: /create account/i }).click();
  await p.waitForTimeout(3000);
  log('AFTER REGISTER', p.url(), await body());
  await shot('4-after-register');
  if (/register|login/.test(p.url())) {
    if (!/login/.test(p.url())) await p.goto('http://localhost:3000/login');
    await p.locator('#login-email').fill(email);
    await p.locator('#login-password').fill(pw);
    await p.getByRole('button', { name: /log in|sign in/i }).last().click();
    await p.waitForTimeout(3000);
    log('AFTER LOGIN', p.url());
  }
  await p.goto('http://localhost:3000/cart'); await p.waitForTimeout(1500);
  log('CART after login', await body());
  await p.goto('http://localhost:3000/checkout'); await p.waitForTimeout(2000);
  log('CHECKOUT', p.url(), await body());
  await shot('5-checkout');
  const place = p.getByRole('button', { name: /place order/i });
  if (mode === 'double') await place.dblclick(); else await place.click();
  await p.waitForURL(/checkout\/pay\//, { timeout: 30000 }).catch(() => log('NO PAY REDIRECT', p.url()));
  log('PAY URL', p.url(), await body());
  await shot('6-pay');
  const orderId = p.url().split('/').pop();
  log('ORDER', orderId);
  // card
  const fr = p.frameLocator('iframe').first();
  const pmBtn = p.getByText(/Visa test card/i).first();
  if (await pmBtn.count()) await pmBtn.click();
  await p.waitForTimeout(500);
  const pay = p.getByRole('button', { name: /^pay/i }).first();
  if (mode === 'reload') {
    await pay.click();
    await p.reload();
    await p.waitForTimeout(1500);
    log('AFTER RELOAD', await body());
    await shot('7-reload');
  } else if (mode === 'double') {
    await pay.dblclick();
  } else {
    await pay.click();
  }
  for (let i = 0; i < 20; i++) {
    await p.waitForTimeout(2000);
    const t = await body();
    if (/Order confirmed|didn't go through|cancelled/i.test(t)) break;
  }
  log('FINAL', p.url(), await body());
  await shot('8-final');
  await p.goto('http://localhost:3000/orders'); await p.waitForTimeout(2500);
  log('ORDERS', await body());
  await shot('9-orders');
  log('CSP errors', csp, 'EMAIL', email);
  await b.close();
})();
