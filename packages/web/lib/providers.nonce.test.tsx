// @vitest-environment node
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Providers } from './providers';

// Rendered in a Node environment on purpose: next-themes writes the nonce only when there is no `window`, i.e. on the
// server, and that server markup is what the browser checks against the policy.
describe('W07 providers nonce (AS-06)', () => {
  it('W07 AS-06: the theme bootstrap script carries the nonce it is given', () => {
    const markup = renderToString(
      <Providers nonce="abc123nonce">
        <p>child</p>
      </Providers>,
    );
    expect(markup).toMatch(/<script[^>]*\bnonce="abc123nonce"/);
  });

  it('W07 AS-06: without a nonce the script has none', () => {
    const markup = renderToString(
      <Providers>
        <p>child</p>
      </Providers>,
    );
    expect(markup).not.toContain('abc123nonce');
  });
});
