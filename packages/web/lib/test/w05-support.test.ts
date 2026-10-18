import { describe, expect, it } from 'vitest';
import { chunkedResponse, controlledStream, sseFrame } from '@/tests/support/chunked-stream';
import { createFakeLive } from '@/tests/support/fake-live';

async function readAll(response: Response): Promise<{ text: string; error?: unknown }> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { text };
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    return { text, error };
  }
}

describe('W05 test support (tooling check, gaps T1/T2/T7)', () => {
  it('a chunked response delivers the chunks in order and can be cut with an error', async () => {
    expect(await readAll(chunkedResponse(['a', 'b']))).toEqual({ text: 'ab' });
    const cut = await readAll(chunkedResponse(['a'], { drop: 'error' }));
    expect(cut.text).toBe('a');
    expect(cut.error).toBeInstanceOf(TypeError);
  });

  it('a controlled stream stays open until pushed, closed or dropped, and reports a cancel', async () => {
    const stream = controlledStream();
    const read = readAll(stream.response);
    stream.push(sseFrame('text', { t: 'x' }, '1-0'));
    stream.close();
    expect((await read).text).toBe('id: 1-0\nevent: text\ndata: {"t":"x"}\n\n');
    const other = controlledStream();
    await other.response.body!.cancel();
    expect(other.cancelled()).toBe(true);
  });

  it('the fake live connection counts holders, delivers frames, resync and revoked', () => {
    const live = createFakeLive();
    const seen: string[] = [];
    const release = live.subscribeTopic('chat:1', (event) => seen.push(event.type), ['message']);
    live.subscribeTopic('chat:2', (event) => seen.push(`2:${event.type}`));
    live.emit('chat:1', 'message', {});
    live.resync();
    live.revoked('chat:2');
    expect(seen).toEqual(['message', 'resync', '2:resync', '2:revoked']);
    expect(live.held()).toEqual(['chat:1']);
    release();
    expect(live.held()).toEqual([]);
    expect(live.subscribed()).toEqual(['chat:1', 'chat:2']);
  });
});
