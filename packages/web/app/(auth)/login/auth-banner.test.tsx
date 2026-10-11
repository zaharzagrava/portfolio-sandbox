import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { NOTICES, PROVIDER_ERRORS } from '@/lib/auth/copy';
import { AuthBanner } from './auth-banner';

describe('AuthBanner', () => {
  it.each(Object.entries(NOTICES))('W01 AS-15: notice %s renders one status banner with the catalogue copy', (key, copy) => {
    render(<AuthBanner notice={key} />);
    expect(screen.getByRole('status')).toHaveTextContent(copy);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it.each(Object.entries(PROVIDER_ERRORS))('W01 AS-15: provider error %s renders one alert banner with the catalogue copy', (key, copy) => {
    render(<AuthBanner error={key} />);
    expect(screen.getByRole('alert')).toHaveTextContent(copy);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('W01 AS-15: the exact FR-043 and FR-044 strings are shown', () => {
    const { rerender } = render(<AuthBanner notice="registered" />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Thanks for signing up. Sign in with your email and password to continue. If you already had an account, use your existing password or reset it.',
    );
    rerender(<AuthBanner notice="session_expired" />);
    expect(screen.getByRole('status')).toHaveTextContent('Your session ended. Sign in again to continue.');
    rerender(<AuthBanner error="oidc_denied" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Google sign-in was cancelled. You can try again or use your email and password.');
  });

  it.each([['nope'], ['<b>x</b>'], [''], ['__proto__'], ['constructor'], ['toString']])('W01 AS-15: unknown value %j shows nothing and is never echoed', (value) => {
    const { container } = render(<AuthBanner notice={value} error={value} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('W01 AS-15: a repeated parameter (array) and a missing value show nothing', () => {
    const { container } = render(<AuthBanner notice={['registered', 'signed_out']} error={['oidc_denied']} />);
    expect(container).toBeEmptyDOMElement();
    const empty = render(<AuthBanner />);
    expect(empty.container).toBeEmptyDOMElement();
  });

  it('W01 AS-15: with both values valid exactly one banner appears, the error winning', () => {
    const { container } = render(<AuthBanner notice="registered" error="oidc_denied" />);
    expect(container.children).toHaveLength(1);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('W01 AS-15: an unknown error does not hide a valid notice', () => {
    render(<AuthBanner notice="signed_out" error="made_up" />);
    expect(screen.getByRole('status')).toHaveTextContent("You've been signed out.");
  });
});
