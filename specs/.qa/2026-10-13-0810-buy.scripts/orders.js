const { chromium } = require('/home/zagrava/workspace/personal-projects/portfolio-sandbox/packages/web/node_modules/@playwright/test');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.goto('http://localhost:3000/login');
  await p.locator('#login-email').fill(process.argv[2]);
  await p.locator('#login-password').fill('SuperSecurePassword123!');
  await p.getByRole('button', { name: /sign in/i }).last().click();
  await p.waitForTimeout(3000);
  console.log('nav links', await p.$$eval('header a, nav a', (as) => as.map((a) => a.textContent + '=>' + a.getAttribute('href'))));
  for (const u of ['/orders', '/dashboard/orders']) {
    const r = await p.goto('http://localhost:3000' + u);
    await p.waitForTimeout(2500);
    console.log(u, r.status(), p.url(), (await p.innerText('body')).replace(/\n+/g, ' | ').slice(0, 500));
    await p.screenshot({ path: '/tmp/tmp.HuYqr45gbw/orders' + u.replace(/\//g, '_') + '.png' });
  }
  await b.close();
})();
