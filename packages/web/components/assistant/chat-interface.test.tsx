import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DONE, META, TEXT, TOOL, type FakeCall } from '../../tests/support/fake-assistant';

const fake = await vi.hoisted(async () => (await import('../../tests/support/fake-assistant')).createFakeAssistant());
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), message: vi.fn() }));

vi.mock('sonner', () => ({ toast }));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'u1', email: 'a@b.c', role: 'USER' }, status: 'authenticated', isAuthenticated: true, isLoading: false }) }));
vi.mock('@/lib/api/assistant', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/api/assistant')>()), assistantApi: fake.api }));

import { useAssistantChat } from '@/hooks/use-assistant-chat';
import { AssistantRejected } from '@/lib/api/assistant';
import { ChatInterface } from './chat-interface';

function Harness() {
  const chat = useAssistantChat({ active: true });
  return <ChatInterface chat={chat} />;
}

function renderInterface(ui: ReactNode = <Harness />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const field = () => screen.getByRole('textbox', { name: 'Message to the assistant' });
const sendButton = () => screen.getByRole('button', { name: 'Send message' });
const emit = (call: FakeCall, ...events: Parameters<FakeCall['emit']>[]) => act(() => events.forEach(([event, id]) => call.emit(event, id)));

async function ask(text: string) {
  const n = fake.calls.length;
  await userEvent.type(field(), `${text}{Enter}`);
  return fake.call(n);
}

beforeEach(() => {
  fake.reset();
  sessionStorage.clear();
  toast.error.mockClear();
  fake.api.usage.mockResolvedValue({ used: 12_000, limit: 100_000, resetsAt: '2026-11-01T00:00:00.000Z' });
});
afterEach(() => vi.restoreAllMocks());

describe('Assistant interface', () => {
  it('W05 AS-41: a member with no conversation sees the greeting and the composer', async () => {
    renderInterface();
    expect(screen.getByText("Hi! I'm your AI Shopping Assistant.")).toBeInTheDocument();
    expect(screen.getByText('How can I help you today?')).toBeInTheDocument();
    expect(field()).toHaveAttribute('placeholder', 'Ask me anything...');
    expect(sendButton()).toBeDisabled();
  });

  it('W05 AS-42: asking shows the question at once, empties the field, swaps Send for Stop and shows "Thinking…"', async () => {
    renderInterface();
    const call = await ask('hi');
    expect(screen.getByTestId('user-message')).toHaveTextContent('hi');
    expect(field()).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Send message' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Stop generating' })).toBeInTheDocument();
    expect(screen.getByText('Thinking…')).toBeInTheDocument();
    expect(call.args[0]).toBe('0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b');
  });

  it('W05 AS-42: text events append in arrival order; on done Send returns, "Answer ready" is announced once and no toast was used', async () => {
    renderInterface();
    const call = await ask('hi');
    emit(call, [META(), '1-0'], [TEXT('Hello'), '2-0']);
    expect(screen.getByTestId('assistant-message')).toHaveTextContent('Hello');
    expect(screen.queryByText('Thinking…')).toBeNull();
    emit(call, [TEXT(', there'), '3-0'], [TEXT('!'), '4-0']);
    expect(screen.getByTestId('assistant-message')).toHaveTextContent('Hello, there!');
    expect(screen.getByRole('log')).toHaveAttribute('aria-busy', 'true');

    emit(call, [DONE(20, 100), '5-0']);
    await act(async () => call.end({ terminal: true }));
    expect(screen.getByRole('button', { name: 'Send message' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop generating' })).toBeNull();
    expect(screen.getByRole('log')).toHaveAttribute('aria-busy', 'false');
    expect(screen.getAllByText('Answer ready')).toHaveLength(1);
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.message).not.toHaveBeenCalled();
  });

  it('W05 AS-42: the view follows the end of the answer unless the reader scrolled up', async () => {
    renderInterface();
    const log = screen.getByRole('log');
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 200 });
    let top = 0;
    Object.defineProperty(log, 'scrollTop', { configurable: true, get: () => top, set: (value: number) => void (top = value) });
    const call = await ask('hi');
    emit(call, [META(), '1-0'], [TEXT('one'), '2-0']);
    expect(log.scrollTop).toBe(1000);

    log.scrollTop = 100;
    fireEvent.scroll(log);
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 1400 });
    emit(call, [TEXT(' two'), '3-0']);
    expect(log.scrollTop).toBe(100);
  });

  it('W05 AS-43: tool chips appear above the answer and are updated by id', async () => {
    renderInterface();
    const call = await ask('phone');
    emit(call, [META(), '1-0'], [TOOL('t1', 'search_products', 'running'), '2-0']);
    expect(screen.getByText('Searching products…')).toBeInTheDocument();
    emit(call, [TOOL('t1', 'search_products', 'done'), '3-0'], [TEXT('Found'), '4-0']);
    expect(screen.queryByText('Searching products…')).toBeNull();
    expect(screen.getByText('Searched products')).toBeInTheDocument();
  });

  it('W05 AS-45: Enter sends, Shift+Enter adds a line, and Enter during IME composition does not send', async () => {
    renderInterface();
    await userEvent.type(field(), 'line one{Shift>}{Enter}{/Shift}line two');
    expect(field()).toHaveValue('line one\nline two');
    expect(fake.api.send).not.toHaveBeenCalled();

    fireEvent.keyDown(field(), { key: 'Enter', isComposing: true, keyCode: 229 });
    expect(fake.api.send).not.toHaveBeenCalled();

    await userEvent.type(field(), '{Enter}');
    await fake.call(0);
    expect(fake.api.send.mock.calls[0][1]).toMatchObject({ text: 'line one\nline two' });
  });

  it('W05 AS-45: whitespace-only text keeps Send disabled; the counter appears beyond 3,500 characters; typing past 4,000 is cut', async () => {
    renderInterface();
    await userEvent.type(field(), '   ');
    expect(sendButton()).toBeDisabled();
    expect(screen.queryByText(/\/ 4,000/)).toBeNull();

    fireEvent.change(field(), { target: { value: 'a'.repeat(3600) } });
    expect(screen.getByText('3,600 / 4,000')).toBeInTheDocument();
    fireEvent.change(field(), { target: { value: 'b'.repeat(4200) } });
    expect((field() as HTMLTextAreaElement).value).toHaveLength(4000);
    expect(screen.getByText('4,000 / 4,000')).toBeInTheDocument();
  });

  it('W05 AS-45: while a reply runs the field stays editable but sending is disabled', async () => {
    renderInterface();
    const call = await ask('first');
    emit(call, [META(), '1-0']);
    await userEvent.type(field(), 'second{Enter}');
    expect(field()).toHaveValue('second');
    expect(fake.api.send).toHaveBeenCalledTimes(1);
  });

  it('W05 AS-46: the location switch is off by default and asks nothing until it is switched on', async () => {
    const getCurrentPosition = vi.mocked(navigator.geolocation.getCurrentPosition);
    getCurrentPosition.mockClear();
    renderInterface();
    const toggle = screen.getByRole('switch', { name: 'Use my location' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(getCurrentPosition).not.toHaveBeenCalled();
    const call = await ask('hello');
    expect(call.args[1]).not.toHaveProperty('lat');
    expect(call.args[1]).not.toHaveProperty('lng');
  });

  it('W05 AS-46: switching on asks once, then every send carries lat and lng; switching off stops sending them; nothing is stored', async () => {
    const getCurrentPosition = vi.mocked(navigator.geolocation.getCurrentPosition);
    getCurrentPosition.mockReset();
    getCurrentPosition.mockImplementation((success) => success({ coords: { latitude: 52.52, longitude: 13.405, accuracy: 5 } } as GeolocationPosition));
    renderInterface();
    const toggle = screen.getByRole('switch', { name: 'Use my location' });
    await userEvent.click(toggle);
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    const first = await ask('near me');
    expect(first.args[1]).toMatchObject({ text: 'near me', lat: 52.52, lng: 13.405 });
    emit(first, [META(), '1-0'], [DONE(), '2-0']);
    await act(async () => first.end({ terminal: true }));
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);

    await userEvent.click(toggle);
    const second = await ask('anywhere');
    expect(second.args[1]).not.toHaveProperty('lat');
    expect(JSON.stringify({ ...sessionStorage })).not.toMatch(/52\.5|13\.4/);
    expect(JSON.stringify({ ...localStorage })).not.toMatch(/52\.5|13\.4/);

    await userEvent.click(toggle);
    expect(getCurrentPosition).toHaveBeenCalledTimes(2);
  });

  it('W05 AS-46: a denied lookup turns the switch off and says so inline', async () => {
    const getCurrentPosition = vi.mocked(navigator.geolocation.getCurrentPosition);
    getCurrentPosition.mockReset();
    getCurrentPosition.mockImplementation((_ok, fail) => fail?.({ code: 1, message: 'x', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError));
    renderInterface();
    await userEvent.click(screen.getByRole('switch', { name: 'Use my location' }));
    expect(screen.getByRole('switch', { name: 'Use my location' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Location unavailable. Allow location access in your browser to use this.')).toBeInTheDocument();
    const call = await ask('hi');
    expect(call.args[1]).not.toHaveProperty('lat');
  });

  it('W05 AS-47: the allowance line shows the rounded-down percentage next to a progress element', async () => {
    fake.api.usage.mockResolvedValue({ used: 1999, limit: 10_000, resetsAt: '2026-11-01T00:00:00.000Z' });
    renderInterface();
    expect(await screen.findByText('19% of your monthly allowance used')).toBeInTheDocument();
    const meter = screen.getByLabelText('Monthly allowance used');
    expect(meter.tagName).toBe('PROGRESS');
    expect(meter).toHaveAttribute('value', '19');
  });

  it('W05 AS-47: the meter updates from done.allowance, and at 100% reads used up with the composer disabled', async () => {
    renderInterface();
    expect(await screen.findByText('12% of your monthly allowance used')).toBeInTheDocument();
    const call = await ask('hi');
    emit(call, [META(), '1-0'], [TEXT('x'), '2-0'], [DONE(50_000, 100_000), '3-0']);
    await act(async () => call.end({ terminal: true }));
    expect(screen.getByText('50% of your monthly allowance used')).toBeInTheDocument();

    const second = await ask('again');
    emit(second, [META('m2'), '4-0'], [TEXT('y'), '5-0'], [DONE(100_000, 100_000), '6-0']);
    await act(async () => second.end({ terminal: true }));
    const date = new Date('2026-11-01T00:00:00.000Z').toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
    expect(screen.getByText(`Monthly allowance used up. Resets ${date}.`)).toBeInTheDocument();
    expect(field()).toBeDisabled();
  });

  it('W05 AS-47: a failed usage read shows nothing and never blocks sending', async () => {
    fake.api.usage.mockRejectedValue(new Error('down'));
    renderInterface();
    await vi.waitFor(() => expect(fake.api.usage).toHaveBeenCalled());
    expect(screen.queryByLabelText('Monthly allowance used')).toBeNull();
    expect(screen.queryByText(/monthly allowance/)).toBeNull();
    await ask('hi');
    expect(fake.api.send).toHaveBeenCalledTimes(1);
  });

  it('W05 AS-66: the Send and Stop controls and the field have accessible names and 44 px targets', async () => {
    renderInterface();
    expect(sendButton()).toHaveClass('min-h-11', 'min-w-11');
    await ask('hi');
    expect(screen.getByRole('button', { name: 'Stop generating' })).toHaveClass('min-h-11', 'min-w-11');
    expect(within(screen.getByRole('log')).getAllByText(/said:/).length).toBeGreaterThan(0);
  });
});

const rejected = (status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) => new AssistantRejected(status, body, headers);

describe('Assistant interface: refusals and errors in place', () => {
  afterEach(() => vi.useRealTimers());

  const BEFORE_STREAM: [string, number, Record<string, unknown>, Record<string, string>, string][] = [
    ['validation_failed', 400, { code: 'validation_failed' }, {}, "That message can't be sent. Messages can be up to 4,000 characters."],
    ['input_rejected / sensitive_data', 422, { code: 'input_rejected', category: 'sensitive_data' }, {}, 'Your message looks like it contains a card number or a password. Remove it and try again.'],
    ['input_rejected / other', 422, { code: 'input_rejected', category: 'hate' }, {}, "I can't help with that request."],
    ['turn_in_progress', 409, { code: 'turn_in_progress' }, {}, 'The assistant is still answering. Wait for it to finish.'],
    ['too_many_active_turns', 429, { code: 'too_many_active_turns' }, {}, 'The assistant is already answering in other chats. Wait for one to finish.'],
    ['assistant_busy', 503, { code: 'assistant_busy' }, { 'retry-after': '30' }, 'The assistant is busy right now. Try again in 30 seconds.'],
    ['assistant_unavailable', 503, { code: 'assistant_unavailable' }, {}, 'The assistant is unavailable right now. Try again in a moment.'],
    ['idempotency_key_required (a defect)', 422, { code: 'idempotency_key_required' }, {}, 'Something went wrong. Try again.'],
    ['an unknown 4xx', 418, { code: 'teapot' }, {}, "Something didn't work. Check the details and try again."],
    ['an unknown 5xx', 502, {}, {}, 'Something went wrong. Try again.'],
  ];

  it.each(BEFORE_STREAM)('W05 AS-56: %s -> an inline alert, the text kept in the field, nothing added to the transcript, no toast', async (_name, status, body, headers, copy) => {
    renderInterface();
    const call = await ask('my question');
    await act(async () => call.fail(rejected(status, body, headers)));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(copy);
    expect(field()).toHaveValue('my question');
    expect(screen.queryByTestId('user-message')).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
    // a refusal that names a wait keeps Send off until the wait ends; the others leave it on
    if (headers['retry-after']) expect(sendButton()).toBeDisabled();
    else expect(sendButton()).toBeEnabled();
  });

  it('W05 AS-56: rate_limited disables Send for the wait, then a timer enables it again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderInterface();
    const call = await ask('hi');
    await act(async () => call.fail(rejected(429, { code: 'rate_limited' }, { 'retry-after': '20' })));
    expect(screen.getByRole('alert')).toHaveTextContent("You're sending messages too fast. Try again in 20 seconds.");
    expect(sendButton()).toBeDisabled();
    expect(field()).toHaveValue('hi');
    await act(async () => vi.advanceTimersByTimeAsync(19_000));
    expect(sendButton()).toBeDisabled();
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    expect(sendButton()).toBeEnabled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('W05 AS-56: not_found resets the sheet to an empty conversation and keeps the text', async () => {
    renderInterface();
    const call = await ask('hi');
    await act(async () => call.fail(rejected(404, { code: 'not_found' })));
    expect(screen.getByRole('alert')).toHaveTextContent('This chat no longer exists.');
    expect(field()).toHaveValue('hi');
    expect(screen.getByText("Hi! I'm your AI Shopping Assistant.")).toBeInTheDocument();
  });

  it('W05 AS-64 AS-56: conversation_full replaces the composer with "This chat is full." and New chat; the history stays readable', async () => {
    renderInterface();
    const call = await ask('hi');
    await act(async () => call.fail(rejected(409, { code: 'conversation_full' })));
    expect(screen.getByRole('alert')).toHaveTextContent('This chat is full. Start a new chat to continue.');
    expect(screen.queryByRole('textbox', { name: 'Message to the assistant' })).toBeNull();
    expect(screen.getByText('This chat is full.')).toBeInTheDocument();
    const newChat = screen.getAllByRole('button', { name: 'New chat' });
    expect(newChat.length).toBeGreaterThan(0);
    await userEvent.click(newChat[0]);
    expect(await screen.findByRole('textbox', { name: 'Message to the assistant' })).toBeInTheDocument();
  });

  const ERRORS: [string, 'PROVIDER_UNAVAILABLE' | 'TURN_TIMEOUT' | 'MODERATION_UNAVAILABLE' | 'GENERATION_LOST' | 'INTERNAL', number | undefined, string][] = [
    ['GENERATION_LOST', 'GENERATION_LOST', undefined, 'The reply was interrupted. Ask again to retry.'],
    ['PROVIDER_UNAVAILABLE with retryAfterMs', 'PROVIDER_UNAVAILABLE', 12_000, 'The assistant is busy right now. Try again in 12 seconds.'],
    ['PROVIDER_UNAVAILABLE without', 'PROVIDER_UNAVAILABLE', undefined, 'The assistant is busy right now. Try again in a moment.'],
    ['TURN_TIMEOUT', 'TURN_TIMEOUT', undefined, 'That took too long to answer. Try a shorter or simpler question.'],
    ['MODERATION_UNAVAILABLE', 'MODERATION_UNAVAILABLE', undefined, "The assistant can't check this reply right now. Try again in a moment."],
    ['INTERNAL', 'INTERNAL', undefined, 'The assistant ran into a problem. Try again.'],
  ];

  it.each(ERRORS)('W05 AS-57: terminal %s keeps the partial text and adds an inline alert with Try again', async (_name, code, retryAfterMs, copy) => {
    renderInterface();
    const call = await ask('the question');
    emit(call, [META(), '1-0'], [TEXT('Partial '), '2-0'], [{ event: 'error', code, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }, '3-0']);
    await act(async () => call.end({ terminal: true }));
    expect(screen.getByTestId('assistant-message')).toHaveTextContent('Partial');
    expect(screen.getByRole('alert')).toHaveTextContent(copy);
    expect(sendButton()).toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(field()).toHaveValue('the question');
    // it is not re-sent by itself
    expect(fake.api.send).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('W05 AS-57: a stop ends with "Stopped. This reply wasn\'t saved." and the partial text stays', async () => {
    renderInterface();
    const call = await ask('hi');
    emit(call, [META(), '1-0'], [TEXT('Partial'), '2-0']);
    await userEvent.click(screen.getByRole('button', { name: 'Stop generating' }));
    expect(fake.api.cancel).toHaveBeenCalledWith('m1');
    expect(screen.getByRole('button', { name: 'Stopping…' })).toHaveAttribute('aria-disabled', 'true');
    emit(call, [{ event: 'error', code: 'CANCELLED' }, '3-0']);
    await act(async () => call.end({ terminal: true }));
    expect(screen.getByRole('alert')).toHaveTextContent("Stopped. This reply wasn't saved.");
    expect(screen.getByTestId('assistant-message')).toHaveTextContent('Partial');
    expect(sendButton()).toBeInTheDocument();
  });

  it('W05 AS-58: a refusal replaces the streamed text, keeps the question with a "not saved" note and never shows the category', async () => {
    renderInterface();
    const call = await ask('the question');
    emit(call, [META(), '1-0'], [TEXT('something unsafe'), '2-0'], [{ event: 'refusal', category: 'self_harm', source: 'moderation' }, '3-0']);
    await act(async () => call.end({ terminal: true }));
    expect(screen.queryByText(/something unsafe/)).toBeNull();
    expect(screen.getByTestId('assistant-message')).toHaveTextContent("I can't help with that.");
    expect(screen.getByTestId('user-message')).toHaveTextContent('the question');
    expect(screen.getByRole('alert')).toHaveTextContent("This exchange wasn't saved.");
    expect(document.body.textContent).not.toMatch(/self_harm|self harm/i);
  });

  it('W05 AS-59: quota_exceeded disables the composer with the reset date; at that instant the composer is enabled again and the usage is read again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-10-31T23:59:00.000Z'));
    renderInterface();
    const call = await ask('hi');
    const reads = fake.api.usage.mock.calls.length;
    await act(async () => call.fail(rejected(429, { code: 'quota_exceeded', used: 5, limit: 5, resetsAt: '2026-11-01T00:00:00.000Z' }, { 'retry-after': '60' })));
    const date = new Date('2026-11-01T00:00:00.000Z').toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
    expect(screen.getAllByText(`You've used your monthly assistant allowance. It resets on ${date}.`).length).toBeGreaterThan(0);
    expect(field()).toBeDisabled();
    expect(field()).toHaveValue('hi');
    expect(sendButton()).toBeDisabled();
    expect(fake.api.send).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(61_000));
    expect(field()).toBeEnabled();
    expect(fake.api.usage.mock.calls.length).toBeGreaterThan(reads);
  });

  it('W05 AS-60: a 401 on send runs the session-ended flow without a retry and without an alert', async () => {
    renderInterface();
    const call = await ask('hi');
    await act(async () => call.fail(rejected(401, { code: 'unauthenticated' })));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(fake.api.send).toHaveBeenCalledTimes(1);
  });
});
