const A = 'http://localhost:8000/api';
const paths = ['/products/search', '/products/search?q=iphone', '/products/search?q=iphnoe', '/products/search?q=xpone', '/products/search?q=aipods',
  '/products/search?q=' + encodeURIComponent('*"() AND OR title:x'), '/products/search?limit=0', '/products/search?limit=51', '/products/search?minRating=6', '/products/search?cursor=abc',
  '/products/search?q=' + 'a'.repeat(101), '/products/search?sort=price-asc&limit=5', '/products/search?sort=bogus',
  '/suggest?q=iph', '/suggest?q=', '/suggest?q=iph&limit=11', '/suggest?q=iph*', '/suggest?q=' + 'a'.repeat(101),
  '/trending', '/trending?limit=21', '/trending?category=Audio', '/trending?category=garden', '/trending?foo=1', '/recommendations?productId=abc'];
(async () => {
  for (const p of paths) {
    const t = Date.now();
    try {
      const r = await fetch(A + p);
      const b = await r.text();
      console.log('==', p.slice(0, 90), r.status, Date.now() - t + 'ms', r.headers.get('cache-control') || '', r.headers.get('retry-after') || '');
      console.log(b.slice(0, 300));
    } catch (e) { console.log('==', p, 'ERR', e.message); }
  }
})();
