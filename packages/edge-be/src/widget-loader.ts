/**
 * SD-01 / S44 loader served at /widget/v1/loader.js (at most 5,120 bytes, no dependencies, one function, one global:
 * `MarketplaceWidget`). Embedded on shops' sites as:
 *   <script async src="https://edge.marketplace.dev/widget/v1/loader.js" data-site-key="pk_live_..."></script>
 * It draws a "Buy on Marketplace" button per featured product, opens checkout in an iframe on click, and talks to the
 * iframe ONLY through `postMessage`: explicit target origin, and on receipt the origin, the window and a closed set of
 * message shapes are checked (`marketplace:close`, `marketplace:need-identity`, `marketplace:identity`). Every failure
 * ends in "render nothing"; nothing the server sends is ever parsed as markup, and the theme is re-validated here with
 * the same rules as the backend (specs/domains/S44-storefront-widget/contracts/http-public.md, "Loader").
 */
export function loaderScript(apiOrigin: string): string {
	return String.raw`(function () {
  'use strict';
  if (window.MarketplaceWidget) return;
  var MW = window.MarketplaceWidget = { version: 'v1', identify: null };
  var script = document.currentScript;
  var key = script && script.getAttribute('data-site-key');
  var API = ${JSON.stringify(apiOrigin)};
  if (!key) return;
  var frame = null;
  var HEX = /^#[0-9a-fA-F]{6}$/;
  var RADIUS = /^(?:[0-9]|1[0-9]|2[0-4])px$/;
  var LABEL = /^[^<>\u0000-\u001f\u007f]{1,40}$/;
  var FONTS = { system: 'system-ui,sans-serif', serif: 'Georgia,serif', mono: 'ui-monospace,monospace' };

  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (text) e.textContent = text;
    return e;
  }
  function str(v) { return typeof v === 'string'; }
  function valid(c) {
    if (!c || typeof c !== 'object' || !Array.isArray(c.products) || c.products.length > 12) return false;
    for (var i = 0; i < c.products.length; i++) {
      var p = c.products[i];
      if (!p || !str(p.id) || !str(p.title) || typeof p.inStock !== 'boolean') return false;
    }
    return true;
  }
  function look(t) {
    var s = [];
    if (!t || typeof t !== 'object') t = {};
    if (str(t.primaryColor) && HEX.test(t.primaryColor)) s.push('background:' + t.primaryColor);
    if (str(t.textColor) && HEX.test(t.textColor)) s.push('color:' + t.textColor);
    if (str(t.backgroundColor) && HEX.test(t.backgroundColor)) s.push('border-color:' + t.backgroundColor);
    if (str(t.borderRadius) && RADIUS.test(t.borderRadius)) s.push('border-radius:' + t.borderRadius);
    if (str(t.fontFamily) && FONTS.hasOwnProperty(t.fontFamily)) s.push('font-family:' + FONTS[t.fontFamily]);
    return { css: s.join(';'), label: str(t.buttonLabel) && LABEL.test(t.buttonLabel) ? t.buttonLabel : null };
  }
  function send(f, token) {
    try { if (frame === f) f.contentWindow.postMessage({ type: 'marketplace:identity', token: token }, API); } catch (e) {}
  }
  function identity(f) {
    if (typeof MW.identify !== 'function') return;
    var done = false;
    function end(token) { if (done) return; done = true; clearTimeout(timer); send(f, token); }
    var timer = setTimeout(function () { end(null); }, 5000);
    try {
      Promise.resolve(MW.identify()).then(function (t) { end(str(t) && t ? t : null); }, function () { end(null); });
    } catch (e) { end(null); }
  }
  function open(id) {
    if (frame) return;
    frame = el('iframe', {
      src: API + '/api/widget/v1/embed?key=' + encodeURIComponent(key) + '#product=' + encodeURIComponent(id),
      title: 'Marketplace checkout',
      allow: 'payment',
      referrerpolicy: 'strict-origin-when-cross-origin',
      loading: 'eager',
      style: 'position:fixed;inset:0;width:100%;height:100%;border:0;z-index:2147483647'
    });
    document.body.appendChild(frame);
  }

  window.addEventListener('message', function (event) {
    var f = frame, m = event.data;
    if (!f || event.origin !== API || event.source !== f.contentWindow) return;
    if (!m || typeof m !== 'object' || Array.isArray(m) || Object.keys(m).length !== 1) return;
    if (m.type === 'marketplace:close') { f.remove(); frame = null; }
    else if (m.type === 'marketplace:need-identity') identity(f);
  });

  fetch(API + '/api/widget/v1/config?key=' + encodeURIComponent(key), { credentials: 'omit' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (config) {
      if (!valid(config)) return;
      var mount = document.querySelector('[data-marketplace-widget]') || script.parentNode;
      var look1 = look(config.theme);
      config.products.forEach(function (p) {
        var b = el('button', { type: 'button', 'data-product': p.id }, look1.label || 'Buy ' + p.title + ' on Marketplace');
        if (look1.css) b.setAttribute('style', look1.css);
        if (!p.inStock) b.setAttribute('disabled', 'disabled');
        else b.addEventListener('click', function () { open(p.id); });
        mount.appendChild(b);
      });
    })
    .catch(function () {});
})();`;
}
