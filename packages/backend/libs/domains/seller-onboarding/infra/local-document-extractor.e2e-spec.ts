import { LocalDocumentExtractor } from './local-document-extractor';
import { extractDocumentBody } from '../application/onboarding-documents.service';

const DOCUMENT = '3b1f6c3e-8a52-4c1e-9a47-2f5d0e0f9a11';

const build = () => {
  const consumers: Array<{
    queue: string;
    handler: (m: { body: { documentId: string } }) => Promise<void>;
    options: { bodySchema?: unknown };
    stop: jest.Mock;
  }> = [];
  const queue = {
    consume: jest.fn((queue, handler, options) => {
      const stop = jest.fn().mockResolvedValue(undefined);
      consumers.push({ queue, handler, options, stop });
      return stop;
    }),
  };
  const extraction = {
    process: jest.fn().mockResolvedValue(undefined),
    routeToReview: jest.fn().mockResolvedValue(undefined),
  };
  const worker = new LocalDocumentExtractor(
    queue as never,
    extraction as never,
  );
  return { worker, consumers, extraction };
};

describe('the document extractor of the local deployment (J02 G-11)', () => {
  it('S04 G-11: consumes onboarding-documents and its dead-letter queue, validating the body where it is read', () => {
    const { worker, consumers } = build();
    worker.onApplicationBootstrap();
    expect(consumers.map((c) => c.queue)).toEqual([
      'onboarding-documents',
      'onboarding-documents-dlq',
    ]);
    for (const c of consumers)
      expect(c.options.bodySchema).toBe(extractDocumentBody);
  });

  it('S04 G-11: a message runs the extraction; a dead letter sends the document to human review', async () => {
    const { worker, consumers, extraction } = build();
    worker.onApplicationBootstrap();
    await consumers[0].handler({ body: { documentId: DOCUMENT } });
    expect(extraction.process).toHaveBeenCalledWith(DOCUMENT);
    await consumers[1].handler({ body: { documentId: DOCUMENT } });
    expect(extraction.routeToReview).toHaveBeenCalledWith(
      DOCUMENT,
      'extraction_unavailable',
    );
  });

  it('S04 G-11: shutdown stops both consumers', async () => {
    const { worker, consumers } = build();
    worker.onApplicationBootstrap();
    await worker.onModuleDestroy();
    for (const c of consumers) expect(c.stop).toHaveBeenCalledTimes(1);
  });
});
