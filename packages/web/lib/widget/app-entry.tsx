import { createRoot } from 'react-dom/client';
import { CheckoutApp } from '@/components/widget/checkout-app';
import { hostOriginOf } from '@/lib/widget/messages';

/**
 * Entry of the widget checkout bundle (`pnpm build:widget` → `.widget/app.js`, served at `/widget/v1/app.js`). The embed
 * document (S44) holds `<div id="widget-root" data-site="{publishable key}">` and loads this script with a nonce.
 */
const root = document.getElementById('widget-root');
if (root) {
  const siteKey = decodeURIComponent(root.getAttribute('data-site') ?? '');
  const framed = window.parent !== window;
  const ancestors = (window.location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins;
  createRoot(root).render(
    <CheckoutApp
      siteKey={siteKey}
      hostOrigin={framed ? hostOriginOf({ ancestorOrigins: ancestors, referrer: document.referrer }) : null}
      parent={framed ? window.parent : null}
    />,
  );
}
