import { render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../vitest.setup';

describe('W07 test tooling', () => {
  it('W07 setup: a .tsx component renders with jest-dom matchers', () => {
    render(<button type="button">Hello</button>);
    expect(screen.getByRole('button', { name: 'Hello' })).toBeVisible();
  });

  it('W07 setup: MSW intercepts a fetch', async () => {
    server.use(http.get('http://localhost/ping', () => HttpResponse.json({ ok: true })));
    const res = await fetch('http://localhost/ping');
    expect(await res.json()).toEqual({ ok: true });
  });
});
