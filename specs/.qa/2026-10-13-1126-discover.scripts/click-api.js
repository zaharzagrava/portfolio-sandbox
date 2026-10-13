const A = 'http://localhost:8000/api';
(async () => {
  const s = await (await fetch(A + '/products/search?q=desk')).json();
  const pid = s.items[0].id;
  for (const body of [{ searchId: s.searchId, productId: pid, position: 0 }, { query: 'desk', productId: pid, position: 0 }]) {
    for (const base of [A, 'http://localhost:3000/api']) {
      const r = await fetch(base + '/search/clicks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      console.log(base, Object.keys(body).join(','), r.status, (await r.text()).slice(0, 300));
    }
  }
})();
