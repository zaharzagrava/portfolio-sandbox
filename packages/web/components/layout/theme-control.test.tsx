import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from 'next-themes';
import { beforeEach, describe, expect, it } from 'vitest';
import { THEME_STORAGE_KEY } from '@/lib/browser-storage-keys';
import { ThemeControl } from './theme-control';

const renderControl = () =>
  render(
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem storageKey={THEME_STORAGE_KEY}>
      <ThemeControl />
    </ThemeProvider>,
  );

describe('W07 theme control (AS-06)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.className = '';
  });

  it('W07 AS-06: a button named "Theme" opens a menu with Light, Dark and System', async () => {
    renderControl();
    await userEvent.click(screen.getByRole('button', { name: 'Theme' }));
    expect(screen.getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual(['Light', 'Dark', 'System']);
  });

  it('W07 AS-06: the default is System, marked as checked', async () => {
    renderControl();
    await userEvent.click(screen.getByRole('button', { name: 'Theme' }));
    expect(screen.getByRole('menuitemradio', { name: 'System' })).toBeChecked();
    expect(screen.getByRole('menuitemradio', { name: 'Light' })).not.toBeChecked();
    expect(screen.getByRole('menuitemradio', { name: 'Dark' })).not.toBeChecked();
  });

  it('W07 AS-06: choosing Dark applies it at once, persists it under the storage key, and marks it checked', async () => {
    renderControl();
    await userEvent.click(screen.getByRole('button', { name: 'Theme' }));
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'Dark' }));
    expect(document.documentElement).toHaveClass('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    await userEvent.click(screen.getByRole('button', { name: 'Theme' }));
    expect(screen.getByRole('menuitemradio', { name: 'Dark' })).toBeChecked();
  });

  it('W07 AS-06: a saved choice is shown as checked on the next visit', async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    renderControl();
    await userEvent.click(screen.getByRole('button', { name: 'Theme' }));
    expect(screen.getByRole('menuitemradio', { name: 'Light' })).toBeChecked();
  });

  it('W07 AS-06: the icons are decorative', () => {
    const { container } = renderControl();
    for (const icon of container.querySelectorAll('svg')) expect(icon).toHaveAttribute('aria-hidden', 'true');
  });
});
