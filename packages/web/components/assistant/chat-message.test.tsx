import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ToolChip } from '@/lib/assistant/reply-reducer';
import { ChatMessage, type TranscriptMessage } from './chat-message';
import { Transcript } from './transcript';

const assistant = (patch: Partial<TranscriptMessage> = {}): TranscriptMessage => ({ id: 'a1', role: 'assistant', content: 'Hello', tools: [], ...patch });
const user = (patch: Partial<TranscriptMessage> = {}): TranscriptMessage => ({ id: 'u1', role: 'user', content: 'hi', tools: [], ...patch });
const chip = (id: string, name: string, status: ToolChip['status']): ToolChip => ({ id, name, status });

describe('Assistant message', () => {
  it('W05 AS-43: a chip shows its text, per state, for every known tool', () => {
    render(
      <ChatMessage
        message={assistant({
          tools: [
            chip('t1', 'search_products', 'running'),
            chip('t2', 'product_details', 'done'),
            chip('t3', 'pickup_near_me', 'failed'),
            chip('t4', 'pickup_near_me', 'running'),
            chip('t5', 'search_products', 'failed'),
          ],
        })}
      />,
    );
    const chips = screen.getAllByRole('listitem');
    expect(chips.map((c) => c.textContent)).toEqual([
      'Searching products…',
      'Read product details',
      "Couldn't check pickup points",
      'Checking pickup points near you…',
      "Couldn't search products",
    ]);
  });

  it('W05 AS-43: an unknown tool shows its name with the underscores replaced by spaces', () => {
    render(<ChatMessage message={assistant({ tools: [chip('t1', 'compare_prices', 'running')] })} />);
    expect(screen.getByRole('listitem')).toHaveTextContent('compare prices');
  });

  it('W05 AS-43: two calls of one tool are two chips (keyed by id, not by name)', () => {
    render(<ChatMessage message={assistant({ tools: [chip('t1', 'search_products', 'done'), chip('t2', 'search_products', 'running')] })} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('W05 AS-43: chips sit above the answer text', () => {
    render(<ChatMessage message={assistant({ tools: [chip('t1', 'search_products', 'done')] })} />);
    const list = screen.getByRole('list');
    const answer = screen.getByTestId('assistant-message');
    expect(list.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('W05 AS-44: Markdown renders paragraphs, emphasis, lists, tables and code', () => {
    const content = ['**bold** and *soft*', '', '- one', '- two', '', '| a | b |', '|---|---|', '| 1 | 2 |', '', '`inline`', '', '```', 'block', '```'].join('\n');
    render(<ChatMessage message={assistant({ content })} />);
    const answer = screen.getByTestId('assistant-message');
    expect(within(answer).getByText('bold').tagName).toBe('STRONG');
    expect(within(answer).getByText('soft').tagName).toBe('EM');
    expect(within(answer).getAllByRole('listitem')).toHaveLength(2);
    expect(within(answer).getByRole('table')).toBeInTheDocument();
    expect(within(answer).getByText('inline').tagName).toBe('CODE');
    expect(within(answer).getByText('block').closest('pre')).not.toBeNull();
  });

  it('W05 AS-44: raw HTML, scripts and images are never rendered', () => {
    const content = 'before <script>window.pwned = 1</script> <img src="https://x.test/a.png" onerror="alert(1)"> after ![pic](https://x.test/b.png)';
    const { container } = render(<ChatMessage message={assistant({ content })} />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.innerHTML).not.toContain('onerror');
    expect(screen.getByTestId('assistant-message')).toHaveTextContent('before');
    expect(screen.getByTestId('assistant-message')).toHaveTextContent('after');
  });

  it('W05 AS-44: links open in a new tab with rel noopener noreferrer, and only http, https or same-site targets are links', () => {
    const content = '[web](https://example.com/a) [plain](http://example.com) [site](/product/42) [bad](javascript:alert(1)) [data](data:text/html,x) [proto](//evil.test/x)';
    render(<ChatMessage message={assistant({ content })} />);
    const links = screen.getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['https://example.com/a', 'http://example.com', '/product/42']);
    for (const link of links) {
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
    // the refused ones stay readable as text
    for (const label of ['bad', 'data', 'proto']) expect(screen.getByText(label).closest('a')).toBeNull();
  });

  it('W05 AS-66: bubbles carry hidden prefixes for a screen reader', () => {
    render(
      <>
        <ChatMessage message={user({ content: 'find a phone' })} />
        <ChatMessage message={assistant({ content: 'Here you go' })} />
      </>,
    );
    expect(screen.getByText('You said:')).toHaveClass('sr-only');
    expect(screen.getByText('Assistant said:')).toHaveClass('sr-only');
    expect(screen.getByTestId('user-message')).toHaveTextContent('find a phone');
    expect(screen.getByTestId('user-message')).not.toHaveTextContent('You said');
  });

  it('W05 AS-42: a live assistant bubble with no text reads "Thinking…"; "Reconnecting…" and "Stopping…" are status messages', () => {
    const { rerender } = render(<ChatMessage message={assistant({ content: '', live: 'thinking' })} />);
    expect(screen.getByText('Thinking…')).toBeInTheDocument();
    rerender(<ChatMessage message={assistant({ content: 'Hel', live: 'reconnecting' })} />);
    expect(screen.getByRole('status')).toHaveTextContent('Reconnecting…');
    expect(screen.getByTestId('assistant-message')).toHaveTextContent('Hel');
    rerender(<ChatMessage message={assistant({ content: 'Hel', live: 'stopping' })} />);
    expect(screen.getByRole('status')).toHaveTextContent('Stopping…');
  });
});

describe('Assistant transcript', () => {
  it('W05 AS-66: the transcript is a log named for the conversation, busy while a reply streams, with no live region of its own', () => {
    const { rerender } = render(<Transcript items={[user(), assistant({ live: 'streaming' })]} busy announce={{ start: 'The assistant is answering…', end: '' }} />);
    const log = screen.getByRole('log', { name: 'Conversation with the assistant' });
    expect(log).toHaveAttribute('aria-busy', 'true');
    expect(log).not.toHaveAttribute('aria-live');
    rerender(<Transcript items={[user(), assistant()]} busy={false} announce={{ start: '', end: 'Answer ready' }} />);
    expect(screen.getByRole('log')).toHaveAttribute('aria-busy', 'false');
  });

  it('W05 AS-66: two visually hidden polite regions carry the announcements', () => {
    render(<Transcript items={[user(), assistant()]} busy={false} announce={{ start: 'The assistant is answering…', end: 'Answer ready' }} />);
    const regions = screen.getAllByRole('status').filter((r) => r.classList.contains('sr-only'));
    expect(regions).toHaveLength(2);
    expect(regions.map((r) => r.textContent)).toEqual(['The assistant is answering…', 'Answer ready']);
    for (const region of regions) expect(region).toHaveAttribute('aria-live', 'polite');
  });

  it('W05 AS-68: messages are keyed by id, so a reorder keeps each bubble', () => {
    const { rerender } = render(<Transcript items={[user({ id: 'u1', content: 'one' }), assistant({ id: 'a1', content: 'two' })]} busy={false} announce={{ start: '', end: '' }} />);
    const before = screen.getByText('two');
    rerender(<Transcript items={[user({ id: 'u0', content: 'zero' }), user({ id: 'u1', content: 'one' }), assistant({ id: 'a1', content: 'two' })]} busy={false} announce={{ start: '', end: '' }} />);
    expect(screen.getByText('two')).toBe(before);
  });
});
