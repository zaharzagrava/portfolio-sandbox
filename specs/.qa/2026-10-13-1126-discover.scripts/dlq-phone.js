const { chromium } = require('/home/zagrava/workspace/personal-projects/portfolio-sandbox/packages/web/node_modules/@playwright/test');
const B = 'http://localhost:3000';
(async () => {
  const list = await (await fetch('http://localhost:9324/?Action=ListQueues')).text();
  const urls = [...list.matchAll(/<QueueUrl>([^<]+dlq[^<]*)<\/QueueUrl>/g)].map((m) => m[1]);
  let nonEmpty = 0;
  for (const u of urls) {
    const t = await (await fetch(u + '?Action=GetQueueAttributes&AttributeName.1=ApproximateNumberOfMessages')).text();
    const n = (t.match(/<Value>(\d+)<\/Value>/) || [])[1];
    if (n !== '0') { nonEmpty++; console.log('DLQ non-empty', u, n); }
  }
  console.log('dlqs checked', urls.length, 'non-empty', nonEmpty);
  const br = await chromium.launch();
  const page = await (await br.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await page.goto(B + '/search?q=desk', { waitUntil: 'networkidle' });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  console.log('phone horizontal overflow px', overflow);
  const btn = page.getByRole('button', { name: /filters/i });
  console.log('filters button', await btn.count());
  if (await btn.count()) { await btn.first().click(); await page.waitForTimeout(800); }
  await page.screenshot({ path: '/tmp/tmp.BhBcbP1uaH/phone-filters.png' });
  console.log((await page.innerText('body')).replace(/\s+/g, ' ').slice(0, 500));
  await page.goto(B + '/', { waitUntil: 'networkidle' });
  console.log('home overflow', await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth));
  await br.close();
})();
