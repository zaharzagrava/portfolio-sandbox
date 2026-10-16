import { ScriptedLlmProvider } from './scripted.provider';
import type { LlmRequest } from './llm-provider';

const request = (content: unknown[]): LlmRequest =>
  ({
    model: 'm',
    system: [],
    maxTokens: 100,
    messages: [{ role: 'user', content }],
  }) as unknown as LlmRequest;

const pdfDocument = (bytes: string) => ({
  type: 'document',
  source: {
    type: 'base64',
    media_type: 'application/pdf',
    data: Buffer.from(bytes, 'latin1').toString('base64'),
  },
});

/** J01 G-33: a keyless local stack must be able to pass document extraction without a scripted queue (black-box onboarding). */
describe('Scripted LLM provider: reply marker (J01 G-33)', () => {
  const provider = new ScriptedLlmProvider();

  it('J01 G-33: an empty queue answers with the JSON a document carries after the SCRIPTED-REPLY marker', async () => {
    const reply = { documentType: 'BANK_STATEMENT', legible: true };
    const result = await provider.complete(
      request([
        pdfDocument(`%PDF-1.4\n%%EOF\n%SCRIPTED-REPLY:${JSON.stringify(reply)}\n`),
        { type: 'text', text: 'Extract the fields.' },
      ]),
    );

    const text = (result.content as { type: string; text?: string }[]).find(
      (block) => block.type === 'text',
    )?.text;
    expect(JSON.parse(text!)).toEqual(reply);
  });

  it('J01 G-33: a document without the marker keeps the default answer, and a queued turn still wins', async () => {
    const plain = await provider.complete(
      request([pdfDocument('%PDF-1.4\n%%EOF\n'), { type: 'text', text: 'x' }]),
    );
    expect(JSON.stringify(plain.content)).toContain('summary of');

    provider.script({ text: 'queued' });
    const queued = await provider.complete(
      request([pdfDocument('%SCRIPTED-REPLY:{"a":1}\n')]),
    );
    expect(JSON.stringify(queued.content)).toContain('queued');
  });
});
