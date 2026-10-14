import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { browserStorageKeys } from '@/lib/browser-storage-keys';
import PrivacyPage from './page';

function cookiesSection(): string {
  const html = renderToStaticMarkup(createElement(PrivacyPage));
  const start = html.indexOf('id="cookies-and-browser-storage"');
  expect(start, 'the cookies section exists').toBeGreaterThan(-1);
  const next = html.indexOf('<h2', start);
  return html.slice(start, next === -1 ? undefined : next);
}

describe('W07 privacy policy lists what the app stores (AS-23, FR-053)', () => {
  it('W07 AS-23: every cookie and storage key in lib/browser-storage-keys.ts appears in the cookie section', () => {
    const section = cookiesSection();
    const missing = browserStorageKeys.map((entry) => entry.key).filter((key) => !section.includes(key));
    expect(missing).toEqual([]);
  });

  it('W07 AS-23: the list names the store of each key (cookie, local storage, session storage)', () => {
    const section = cookiesSection();
    for (const store of new Set(browserStorageKeys.map((entry) => entry.store))) {
      const label = { cookie: 'Cookie', localStorage: 'Local storage', sessionStorage: 'Session storage' }[store];
      expect(section, store).toContain(label);
    }
  });
});
