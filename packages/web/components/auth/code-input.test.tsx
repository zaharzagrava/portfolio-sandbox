import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CodeInput, normalizeRecoveryCode, normalizeTotp } from './code-input';

function Harness({ mode = 'totp' as 'totp' | 'recovery', onSubmit = vi.fn() }) {
  const [value, setValue] = useState('');
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(value);
      }}
    >
      <CodeInput mode={mode} value={value} onChange={setValue} />
      <button type="submit" disabled={mode === 'totp' ? value.length !== 6 : value.length === 0}>
        Verify
      </button>
    </form>
  );
}

describe('CodeInput', () => {
  it('W01 AS-37: is one labelled input with numeric attributes and maxlength 6', () => {
    render(<Harness />);
    const input = screen.getByLabelText('Authentication code');
    expect(input.tagName).toBe('INPUT');
    expect(input).toHaveAttribute('inputmode', 'numeric');
    expect(input).toHaveAttribute('autocomplete', 'one-time-code');
    expect(input).toHaveAttribute('maxlength', '6');
  });

  it('W01 AS-37: ignores non-digits typed', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByLabelText('Authentication code');
    await user.type(input, '1a2b-3 4');
    expect(input).toHaveValue('1234');
  });

  it.each([
    ['123 456', '123456'],
    ['123-456', '123456'],
    [' 12 34 56 ', '123456'],
    ['1234567890', '123456'],
  ])('W01 AS-37: pasted %j is reduced to its digits (%s)', async (pasted, expected) => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByLabelText('Authentication code');
    await user.click(input);
    await user.paste(pasted);
    expect(input).toHaveValue(expected);
  });

  it('W01 AS-37: Verify stays disabled until 6 digits and nothing is submitted by the sixth digit', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    const input = screen.getByLabelText('Authentication code');
    await user.type(input, '12345');
    expect(screen.getByRole('button', { name: 'Verify' })).toBeDisabled();
    await user.type(input, '6');
    expect(screen.getByRole('button', { name: 'Verify' })).toBeEnabled();
    expect(onSubmit).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledWith('123456');
  });

  it('W01 AS-33: recovery mode is labelled Recovery code with the format hint and no numeric restriction', async () => {
    const user = userEvent.setup();
    render(<Harness mode="recovery" />);
    const input = screen.getByLabelText('Recovery code');
    expect(input).not.toHaveAttribute('inputmode', 'numeric');
    expect(input).not.toHaveAttribute('maxlength');
    expect(input).toHaveAccessibleDescription('Format: XXXXX-XXXXX');
    await user.type(input, 'ab12c-De34F');
    expect(input).toHaveValue('ab12c-De34F');
  });

  it('W01 AS-33: normalises recovery codes: case, hyphen, spaces', () => {
    for (const variant of ['abcde-12345', 'ABCDE12345', ' abcde 12345 ', 'ABCDE-12345\n']) {
      expect(normalizeRecoveryCode(variant)).toBe('ABCDE-12345');
    }
    expect(normalizeTotp('12 34-56')).toBe('123456');
  });

  it('W01 AS-66: aria-invalid and the error message are linked', () => {
    render(<CodeInput mode="totp" value="" onChange={() => undefined} error="That code isn't right." />);
    const input = screen.getByLabelText('Authentication code');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(expect.stringContaining("That code isn't right."));
  });

  it('W01 AS-37: change events with only non-digits leave the value empty', () => {
    render(<Harness />);
    const input = screen.getByLabelText('Authentication code');
    fireEvent.change(input, { target: { value: 'abc' } });
    expect(input).toHaveValue('');
  });
});
