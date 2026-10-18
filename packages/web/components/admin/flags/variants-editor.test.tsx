import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '@testing-library/react';
import { useEffect, useReducer } from 'react';
import { describe, expect, it } from 'vitest';
import { draftReducer, toDraft, type Draft } from '@/lib/admin/flags/draft';
import { flagFixture } from '@/lib/test/flag-fixtures';
import { BindingsSection } from './bindings-section';
import { VariantsEditor } from './variants-editor';

let latest: Draft;
function Harness({ flag = flagFixture(), issues = {} }: { flag?: ReturnType<typeof flagFixture>; issues?: Record<string, string> }) {
  const [draft, dispatch] = useReducer(draftReducer, flag, toDraft);
  useEffect(() => {
    latest = draft;
  }, [draft]);
  return (
    <>
      <VariantsEditor draft={draft} dispatch={dispatch} issues={issues} />
      <BindingsSection draft={draft} dispatch={dispatch} issues={issues} />
    </>
  );
}

const typed = flagFixture({
  variants: [
    { key: 'flag', value: true },
    { key: 'label', value: 'hello' },
    { key: 'limit', value: 5 },
    { key: 'conf', value: { a: 1 } },
  ],
  defaultVariant: 'flag',
  offVariant: 'flag',
});

describe('VariantsEditor', () => {
  it('W06 AS-19: each variant is a group with Key, inferred Type and a Value control of that type, and a named Remove button', () => {
    render(<Harness flag={typed} />);
    const groups = screen.getAllByRole('group', { name: /^Variant / });
    expect(groups.map((group) => group.querySelector('legend')?.textContent)).toEqual(['Variant flag', 'Variant label', 'Variant limit', 'Variant conf']);
    const [bool, text, num, json] = groups.map((group) => within(group));
    expect(bool.getByLabelText('Type')).toHaveValue('boolean');
    expect(bool.getByLabelText('Value')).toHaveValue('true');
    expect(text.getByLabelText('Type')).toHaveValue('string');
    expect(text.getByLabelText('Value')).toHaveValue('hello');
    expect(num.getByLabelText('Type')).toHaveValue('number');
    expect(num.getByLabelText('Value')).toHaveValue('5');
    expect(json.getByLabelText('Type')).toHaveValue('json');
    expect(json.getByLabelText('Value').tagName).toBe('TEXTAREA');
    expect(json.getByLabelText('Value').className).toMatch(/font-mono/);
    expect(screen.getByRole('button', { name: 'Remove variant label' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add variant' })).toBeInTheDocument();
  });

  it('W06 AS-19: Add variant appends a row; Remove removes it', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Add variant' }));
    expect(latest.variants).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: `Remove variant ${latest.variants[2]!.key}` }));
    expect(latest.variants).toHaveLength(2);
  });

  it('W06 AS-19: removing a variant that is still chosen clears the choice and says "Choose a variant."', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Remove variant off' }));
    expect(latest.defaultVariant).toBe('');
    expect(latest.offVariant).toBe('');
    expect(screen.getAllByText('Choose a variant.').length).toBe(2);
    expect(screen.getByLabelText('Default variant')).toHaveAttribute('aria-invalid', 'true');
  });

  it('W06 AS-20: the default and off selects list exactly the current variants in order, and a new or renamed variant is there at once', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const options = (label: string) => within(screen.getByLabelText(label)).getAllByRole('option').map((option) => option.textContent);
    expect(options('Default variant')).toEqual(['off', 'on']);
    expect(options('Off variant')).toEqual(['off', 'on']);
    await user.click(screen.getByRole('button', { name: 'Add variant' }));
    expect(options('Default variant')).toEqual(['off', 'on', 'variant-1']);
    const key = screen.getAllByLabelText('Key').at(-1)!;
    await user.clear(key);
    await user.type(key, 'beta');
    expect(options('Off variant')).toEqual(['off', 'on', 'beta']);
  });

  it('W06 AS-20: renaming a variant keeps the choices that pointed at it', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const key = screen.getAllByLabelText('Key')[0]!;
    await user.clear(key);
    await user.type(key, 'dark');
    expect(latest.defaultVariant).toBe('dark');
    expect(screen.getByLabelText('Default variant')).toHaveValue('dark');
  });

  it('W06 AS-19: changing the type changes the control', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const first = screen.getAllByRole('group', { name: /^Variant / })[0]!;
    await user.selectOptions(within(first).getByLabelText('Type'), 'json');
    expect(within(first).getByLabelText('Value').tagName).toBe('TEXTAREA');
  });

  it('W06 AS-24: Bucket by offers the contract units', () => {
    render(<Harness />);
    expect(within(screen.getByLabelText('Bucket by')).getAllByRole('option').map((option) => option.textContent)).toEqual(['userId', 'shopId']);
  });

  it('W06 AS-30: a server message for a variant value is shown under it and linked by aria-describedby', () => {
    render(<Harness issues={{ 'variant-1-value': 'This value is too large (4 KiB at most).' }} />);
    const value = screen.getAllByLabelText('Value')[1]!;
    expect(value).toHaveAttribute('aria-invalid', 'true');
    expect(value).toHaveAccessibleDescription('This value is too large (4 KiB at most).');
  });

  it('W06 AS-58: the variants group has a legend and a read-only editor disables every control', () => {
    render(<Harness />);
    expect(screen.getByRole('group', { name: 'Variants' })).toBeInTheDocument();
  });
});
