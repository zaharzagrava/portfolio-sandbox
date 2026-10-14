import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { SecurityTabs, parseTab } from './security-tabs';

const panels = {
  'two-step': <p>two-step panel</p>,
  sessions: <p>sessions panel</p>,
  methods: <p>methods panel</p>,
};

const tab = (name: string) => screen.getByRole('tab', { name });

describe('SecurityTabs', () => {
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('W01 AS-53: a tablist with three tabs; only the active panel is in the accessibility tree', () => {
    render(<SecurityTabs initialTab="two-step" panels={panels} />);
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Two-step verification', 'Active sessions', 'Sign-in methods']);
    expect(tab('Two-step verification')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('two-step panel');
    expect(screen.queryByText('sessions panel')).toBeNull();
    expect(screen.queryByText('methods panel')).toBeNull();
  });

  it('W01 AS-53: arrows, Home and End move between tabs and the selected tab is in the URL', async () => {
    const user = userEvent.setup();
    render(<SecurityTabs initialTab="two-step" panels={panels} />);
    tab('Two-step verification').focus();
    await user.keyboard('{ArrowRight}');
    expect(tab('Active sessions')).toHaveFocus();
    expect(screen.getByRole('tabpanel')).toHaveTextContent('sessions panel');
    expect(new URLSearchParams(window.location.search).get('tab')).toBe('sessions');
    await user.keyboard('{End}');
    expect(tab('Sign-in methods')).toHaveFocus();
    expect(new URLSearchParams(window.location.search).get('tab')).toBe('methods');
    await user.keyboard('{ArrowRight}');
    expect(tab('Two-step verification')).toHaveFocus();
    await user.keyboard('{End}{Home}');
    expect(tab('Two-step verification')).toHaveFocus();
    expect(new URLSearchParams(window.location.search).get('tab')).toBe('two-step');
  });

  it('W01 AS-53: clicking a tab selects it and keeps other query parameters', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', '/account/security?linked=google');
    render(<SecurityTabs initialTab="methods" panels={panels} />);
    expect(screen.getByRole('tabpanel')).toHaveTextContent('methods panel');
    await user.click(tab('Active sessions'));
    expect(screen.getByRole('tabpanel')).toHaveTextContent('sessions panel');
    const params = new URLSearchParams(window.location.search);
    expect(params.get('tab')).toBe('sessions');
    expect(params.get('linked')).toBe('google');
  });

  it('W01 AS-53: parseTab ignores unknown values and defaults to two-step', () => {
    expect(parseTab('sessions')).toBe('sessions');
    expect(parseTab('methods')).toBe('methods');
    expect(parseTab('two-step')).toBe('two-step');
    expect(parseTab('<script>')).toBe('two-step');
    expect(parseTab(['sessions', 'methods'])).toBe('two-step');
    expect(parseTab(undefined)).toBe('two-step');
  });
});
