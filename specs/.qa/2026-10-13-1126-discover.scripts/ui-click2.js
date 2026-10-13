const { chromium } = require('/home/zagrava/workspace/personal-projects/portfolio-sandbox/packages/web/node_modules/@playwright/test');
const B = 'http://localhost:3000';
(async () => {
  const br = await chromium.launch();
  const page = await (await br.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  page.on('response', async (r) => { if (/search\/clicks/.test(r.url())) console.log('CLICK', r.status(), await r.text()); });
  await page.goto(B + '/search?q=desk', { waitUntil: 'networkidle' });
  await page.locator('a[href^="/products/"]').first().click();
  await page.waitForURL(/\/products\//);
  await page.waitForTimeout(4000);
  console.log('h1s after client nav (4s):', await page.locator('h1').evaluateAll((e) => e.map((x) => x.textContent + ' visible=' + (x.offsetParent !== null) + ' parent=' + x.parentElement.tagName + '.' + (x.closest('[hidden],[aria-hidden],[inert]') ? 'hiddenAncestor' : 'none'))));
  await page.goto(B + '/', { waitUntil: 'networkidle' });
  await page.getByRole('combobox').first().fill('desk');
  await page.getByRole('combobox').first().press('Enter');
  await page.waitForURL(/search/);
  await page.waitForTimeout(3000);
  console.log('h1s search after nav from home:', await page.locator('h1').evaluateAll((e) => e.map((x) => x.textContent + ' visible=' + (x.offsetParent !== null) + ' ' + (x.closest('[hidden],[aria-hidden],[inert]') ? 'hiddenAncestor' : 'none'))));
  await br.close();
})();
