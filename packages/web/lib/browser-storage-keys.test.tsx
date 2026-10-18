import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import PrivacyPage from '@/app/privacy/page';
import { browserStorageKeys } from './browser-storage-keys';

describe('browser storage keys (W03 T007)', () => {
  it('W03 AS-20: the order and pay attempt keys are declared as sessionStorage entries', () => {
    const attempt = browserStorageKeys.filter((entry) => entry.key.startsWith('w03.attempt.'));
    expect(attempt.map((entry) => entry.key)).toEqual(['w03.attempt.checkout', 'w03.attempt.pay:{orderId}']);
    for (const entry of attempt) expect(entry.store).toBe('sessionStorage');
  });

  it('W05 FR-071: the assistant pointer and the sheet flag are declared as sessionStorage entries and nothing else of W05 is stored', () => {
    const w05 = browserStorageKeys.filter((entry) => entry.key.startsWith('assistant.'));
    expect(w05.map((entry) => entry.key)).toEqual(['assistant.active', 'assistant.sheetOpen']);
    for (const entry of w05) expect(entry.store).toBe('sessionStorage');
    expect(w05.find((entry) => entry.key === 'assistant.active')!.purpose).toMatch(/tab/i);
  });

  it('W03 AS-20: the privacy page lists every key the app writes in the browser, with its purpose', () => {
    render(<PrivacyPage />);
    for (const { key, purpose } of browserStorageKeys) {
      expect(screen.getByText(key), key).toBeInTheDocument();
      expect(screen.getAllByText(purpose, { exact: false }).length, purpose).toBeGreaterThan(0);
    }
  });
});
