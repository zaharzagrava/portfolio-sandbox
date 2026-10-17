import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { installClipboardStub } from '@/lib/test/clipboard-stub';
import { CopyButton } from './copy-button';

function setup(mode: 'granted' | 'denied') {
  const user = userEvent.setup();
  const clipboard = installClipboardStub(mode);
  return { user, clipboard };
}

describe('W04 CopyButton', () => {
  it('W04 AS-72: an icon button with a name, copying the text and saying so politely', async () => {
    const { user, clipboard } = setup('granted');
    render(<CopyButton text="req_123" label="Copy request ID" />);
    const button = screen.getByRole('button', { name: 'Copy request ID' });
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    await user.click(button);
    expect(clipboard.written).toEqual(['req_123']);
    expect(screen.getByRole('status')).toHaveTextContent('Copied to clipboard');
    expect(screen.getByRole('button', { name: 'Copy request ID' })).toBeInTheDocument();
  });

  it('W04 AS-89: the failure path says how to copy by hand instead of failing silently', async () => {
    const { user } = setup('denied');
    render(<CopyButton text="req_123" label="Copy reference" />);
    await user.click(screen.getByRole('button', { name: 'Copy reference' }));
    expect(screen.getByRole('status')).toHaveTextContent("Couldn't copy. Select the text and press Ctrl+C (⌘C on Mac).");
  });

  it('W04 AS-72: visible text can be shown beside the icon without changing the accessible name rule', () => {
    render(<CopyButton text="x" label="Copy request ID" showLabel />);
    expect(screen.getByRole('button', { name: 'Copy request ID' })).toHaveTextContent('Copy');
  });
});
