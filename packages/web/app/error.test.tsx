import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import ErrorPage from './error';

const GENERIC = 'We hit an unexpected problem. Try again, and if it keeps happening come back in a few minutes.';
const props = (error: Error & { digest?: string }) => ({ error, retry: vi.fn(), reset: vi.fn() });

describe('W07 error boundary (AS-10)', () => {
  it('W07 AS-10: copy, Try again and Go to home; announced as an alert', () => {
    render(<ErrorPage {...props(new Error('boom'))} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Something went wrong' })).toBeInTheDocument();
    expect(screen.getByText(GENERIC)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to home' })).toHaveAttribute('href', '/');
  });

  it('W07 AS-10: the reference line appears only when the failure carries a digest', () => {
    const { rerender } = render(<ErrorPage {...props(new Error('boom'))} />);
    expect(screen.queryByText(/Reference:/)).not.toBeInTheDocument();
    rerender(<ErrorPage {...props(Object.assign(new Error('boom'), { digest: '1234567890' }))} />);
    expect(screen.getByText('Reference: 1234567890')).toBeInTheDocument();
  });

  it('W07 AS-10: Try again calls retry (re-fetch and re-render of the segment)', async () => {
    const p = props(new Error('boom'));
    render(<ErrorPage {...p} />);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(p.retry).toHaveBeenCalledOnce();
  });

  it('W07 AS-10: focus moves to the heading when the state appears and again when a new failure replaces it', () => {
    const { rerender } = render(<ErrorPage {...props(Object.assign(new Error('a'), { digest: 'one' }))} />);
    const heading = screen.getByRole('heading', { name: 'Something went wrong' });
    expect(heading).toHaveFocus();
    (document.activeElement as HTMLElement).blur();
    rerender(<ErrorPage {...props(Object.assign(new Error('b'), { digest: 'two' }))} />);
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toHaveFocus();
  });

  it.each([
    new Error('SELECT * FROM users WHERE id = 1 failed: relation "users" does not exist'),
    Object.assign(new Error('connect ECONNREFUSED 10.0.3.7:5432'), { stack: 'Error: x\n    at /srv/app/db.ts:44:9' }),
    new Error('GET https://internal.example.net/v1/secret?token=abc returned 500'),
    Object.assign(new TypeError('Cannot read properties of undefined'), { digest: 'd-1' }),
  ])('W07 AS-10: nothing from the thrown value is rendered (%s)', (error) => {
    const { container } = render(<ErrorPage {...props(error)} />);
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/SELECT|relation|ECONNREFUSED|10\.0\.3\.7|db\.ts|internal\.example|token=|Cannot read|TypeError/);
  });
});
