const { chromium } = require('/home/zagrava/workspace/personal-projects/portfolio-sandbox/packages/web/node_modules/@playwright/test');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  p.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });
  p.on('pageerror', (e) => console.log('PAGEERR', e.message));
  p.on('response', (r) => { if (r.status() >= 400) console.log('HTTP', r.status(), r.url()); });
  await p.goto('http://localhost:3000/');
  await p.waitForLoadState('networkidle');
  await p.screenshot({ path: '/tmp/tmp.HuYqr45gbw/home.png' });
  console.log((await p.innerText('body')).slice(0, 1500));
  console.log(await p.$$eval('a', (as) => as.map((a) => a.getAttribute('href')).slice(0, 40)));
  await b.close();
})();
