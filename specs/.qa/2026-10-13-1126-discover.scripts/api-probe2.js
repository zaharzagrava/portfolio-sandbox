const A = 'http://localhost:8000/api';
const g = async (p) => { const r = await fetch(A + p); let b; const t = await r.text(); try { b = JSON.parse(t); } catch { b = t; } return { s: r.status, b, h: r.headers }; };
const titles = (b) => (b.items || []).map((i) => i.title.slice(0, 22) + '/' + i.priceMinor).join(' ; ');
(async () => {
  for (const q of ['espresso', 'espreso', 'ESPRESSO', 'keybord', 'headphnes', 'coffee', 'lantern', 'jacket', 'mesh*', 'espresso OR chair', '"standing desk"', 'café', 'ｅｓｐｒｅｳｳｏ', '<script>', "' OR 1=1 --", '   ', 'a', 'desk chair', 'ssd', 'brand:AudioPro', 'title:desk', '-desk', '\\', '%', '\u0000x']) {
    const r = await g('/products/search?q=' + encodeURIComponent(q));
    console.log(JSON.stringify(q), r.s, r.b.mode, r.b.total && r.b.total.value, titles(r.b).slice(0, 220), r.s >= 400 ? JSON.stringify(r.b).slice(0, 200) : '');
  }
  console.log('--sorts');
  for (const s of ['relevance', 'price-asc', 'price-desc', 'newest', 'rating']) {
    const r = await g('/products/search?sort=' + s + '&limit=6');
    console.log(s, r.s, titles(r.b));
  }
  console.log('--paging');
  let cur = null, seen = [], n = 0;
  do {
    const r = await g('/products/search?limit=8' + (cur ? '&cursor=' + encodeURIComponent(cur) : ''));
    console.log('page', n++, r.s, r.b.items && r.b.items.length, !!r.b.nextCursor);
    (r.b.items || []).forEach((i) => seen.push(i.id));
    cur = r.b.nextCursor;
  } while (cur && n < 10);
  console.log('dups', seen.length - new Set(seen).size, 'total seen', seen.length);
  console.log('--filters');
  for (const f of ['category=electronics', 'category=nope', 'minPrice=10000&maxPrice=40000', 'minPrice=500&maxPrice=100', 'inStock=true', 'brand=AudioPro', 'minRating=3', 'semantic=true', 'q=desk&semantic=true', 'facets=true', 'q=desk&sort=price-desc']) {
    const r = await g('/products/search?' + f);
    console.log(f, r.s, r.b.mode, r.b.total && r.b.total.value, titles(r.b).slice(0, 160), r.s >= 400 ? JSON.stringify(r.b).slice(0, 300) : '', r.b.facets ? JSON.stringify(r.b.facets).slice(0, 200) : '');
  }
  console.log('--cursor mismatch');
  const a = await g('/products/search?limit=2');
  const r = await g('/products/search?limit=2&q=desk&cursor=' + encodeURIComponent(a.b.nextCursor));
  console.log(r.s, r.b.code);
  console.log('--suggest');
  for (const q of ['esp', 'ESP', 'mech', 'wire', '%20wir', 'e', 'k', 'zzzz', 'desk']) {
    const r = await g('/suggest?q=' + q);
    console.log(q, r.s, JSON.stringify(r.b).slice(0, 300), r.h.get('cache-control'));
  }
  console.log('--trending');
  const t = await g('/trending');
  console.log(JSON.stringify(t.b.items.map((i) => i.rank + ':' + i.title.slice(0, 15) + ':' + i.score + ':' + i.category)));
  for (const c of ['electronics', 'home', 'audio', 'sports', 'x'.repeat(41)]) { const r = await g('/trending?category=' + c); console.log(c.slice(0, 12), r.s, r.b.items && r.b.items.length); }
  const t2 = await g('/trending?limit=2'); console.log('limit2', t2.b.items.length);
  console.log('--recs');
  const id = t.b.items[0].productId;
  for (const u of ['/products/' + id + '/recommendations', '/products/' + id + '/recommendations?type=bought-together&limit=3', '/products/' + id + '/recommendations?type=also-viewed', '/products/00000000-0000-0000-0000-000000000000/recommendations', '/products/abc/recommendations', '/products/' + id + '/recommendations?limit=21']) {
    const r = await g(u); console.log(u.slice(-70), r.s, JSON.stringify(r.b).slice(0, 250), r.h.get('cache-control'));
  }
})();
