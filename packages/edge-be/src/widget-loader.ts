/**
 * SD-01 loader served at /widget/v1/loader.js (< 5 KB, no dependencies, one IIFE,
 * no globals except `MarketplaceWidget`). Embedded on shops' sites as:
 *   <script async src="https://edge.marketplace.dev/widget/v1/loader.js" data-site-key="pk_live_..."></script>
 * It renders a "Buy on Marketplace" button, opens checkout in an iframe on
 * click, and talks to it ONLY via postMessage with explicit target origins
 * and origin checks on receipt.
 */
export function loaderScript(apiOrigin: string): string {
	return `(function () {
  'use strict';
  if (window.MarketplaceWidget) return;
  var script = document.currentScript;
  var key = script && script.getAttribute('data-site-key');
  var API = ${JSON.stringify(apiOrigin)};
  if (!key) return;

  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (text) e.textContent = text; // never innerHTML with remote data
    return e;
  }

  fetch(API + '/api/widget/v1/config?key=' + encodeURIComponent(key), { credentials: 'omit' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (config) {
      if (!config) return; // unknown key, origin not registered, or kill switch (410): render nothing
      var mount = document.querySelector('[data-marketplace-widget]') || script.parentNode;
      config.products.forEach(function (p) {
        var button = el('button', { type: 'button', 'data-product': p.id }, 'Buy ' + p.title + ' on Marketplace');
        if (!p.inStock) button.setAttribute('disabled', 'disabled');
        button.addEventListener('click', function () { open(p.id); });
        mount.appendChild(button);
      });

      var frame = null;
      function open(productId) {
        frame = el('iframe', {
          src: API + '/api/widget/v1/embed?key=' + encodeURIComponent(key) + '#product=' + encodeURIComponent(productId),
          title: 'Marketplace checkout',
          allow: 'payment',
          style: 'position:fixed;inset:0;width:100%;height:100%;border:0;z-index:2147483647',
        });
        document.body.appendChild(frame);
      }

      window.addEventListener('message', function (event) {
        if (event.origin !== API || !frame || event.source !== frame.contentWindow) return; // only our iframe
        var msg = event.data || {};
        if (msg.type === 'marketplace:close') { frame.remove(); frame = null; }
        if (msg.type === 'marketplace:need-identity' && window.MarketplaceWidget.identify) {
          // The shop's page asks ITS backend for a signed hand-off token, then passes it to our iframe.
          Promise.resolve(window.MarketplaceWidget.identify()).then(function (token) {
            if (token && frame) frame.contentWindow.postMessage({ type: 'marketplace:identity', token: token }, API);
          });
        }
      });
    })
    .catch(function () {});

  window.MarketplaceWidget = { version: 'v1', identify: null };
})();`;
}
