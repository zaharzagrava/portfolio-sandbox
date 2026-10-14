import {
  knowledgeAdminCreateRequestSchema,
  knowledgeCreateRequestSchema,
  knowledgeCreateResponseSchema,
  knowledgeDocumentPageSchema,
  knowledgeDocumentSchema,
  knowledgeListQuerySchema,
  knowledgeReindexResponseSchema,
  ragAskRequestSchema,
  ragStreamEventSchema,
} from '@marketplace-sandbox/contracts';

const ok = (
  s: { safeParse: (v: unknown) => { success: boolean } },
  v: unknown,
) => s.safeParse(v).success;

const ID = '0192b0a0-0000-7000-8000-000000000001';
const HASH = 'a'.repeat(64);
const MIB = 1024 * 1024;

const document = {
  id: ID,
  title: 'Pixel 10 manual',
  visibility: 'PUBLIC',
  productId: ID,
  format: 'MARKDOWN',
  status: 'READY',
  failureCode: null,
  chunkCount: 2,
  createdAt: '2026-10-13T10:00:00.000Z',
  updatedAt: '2026-10-13T10:00:00.000Z',
};

describe('S47 AS-15: knowledge document contract', () => {
  it('S47 AS-15: a document parses and carries no internal field', () => {
    expect(ok(knowledgeDocumentSchema, document)).toBe(true);
    expect(ok(knowledgeDocumentSchema, { ...document, productId: null })).toBe(
      true,
    );
    expect(
      ok(knowledgeDocumentSchema, { ...document, failureCode: 'no_text' }),
    ).toBe(true);
  });

  it.each([
    'storageKey',
    'contentHash',
    'indexedHash',
    'embeddingModel',
    'createdBy',
    'error',
  ])('S47 AS-15: rejects the internal field %s', (field) => {
    expect(ok(knowledgeDocumentSchema, { ...document, [field]: 'x' })).toBe(
      false,
    );
  });

  it('S47 AS-31: page and create response wrap the document', () => {
    expect(
      ok(knowledgeDocumentPageSchema, {
        items: [document],
        nextCursor: null,
      }),
    ).toBe(true);
    expect(
      ok(knowledgeCreateResponseSchema, { document, deduplicated: false }),
    ).toBe(true);
    expect(
      ok(knowledgeCreateResponseSchema, {
        document,
        deduplicated: false,
        upload: {
          url: 'https://s3.test/x',
          headers: { 'x-amz-checksum-sha256': 'abc' },
          expiresAt: '2026-10-13T10:15:00.000Z',
        },
      }),
    ).toBe(true);
    expect(ok(knowledgeReindexResponseSchema, { enqueued: 0 })).toBe(true);
    expect(ok(knowledgeReindexResponseSchema, { enqueued: -1 })).toBe(false);
  });
});

describe('S47 AS-17: knowledge create request contract', () => {
  const md = { title: 'T', visibility: 'PUBLIC', markdown: '# Hi\ntext' };
  const pdf = {
    title: 'T',
    visibility: 'SHOP_PRIVATE',
    pdfSha256: HASH,
    pdfSize: 48213,
  };

  it('S47 AS-17: accepts both forms and the exact limits', () => {
    expect(ok(knowledgeCreateRequestSchema, md)).toBe(true);
    expect(ok(knowledgeCreateRequestSchema, pdf)).toBe(true);
    expect(
      ok(knowledgeCreateRequestSchema, { ...md, title: 'a'.repeat(200) }),
    ).toBe(true);
    expect(
      ok(knowledgeCreateRequestSchema, { ...md, markdown: 'a'.repeat(MIB) }),
    ).toBe(true);
    expect(
      ok(knowledgeCreateRequestSchema, { ...pdf, pdfSize: 20 * MIB }),
    ).toBe(true);
    expect(ok(knowledgeCreateRequestSchema, { ...pdf, pdfSize: 1 })).toBe(true);
    expect(ok(knowledgeCreateRequestSchema, { ...md, productId: ID })).toBe(
      true,
    );
  });

  it.each([
    ['neither form', { title: 'T', visibility: 'PUBLIC' }],
    ['both forms', { ...md, pdfSha256: HASH }],
    [
      'hash without size',
      { title: 'T', visibility: 'PUBLIC', pdfSha256: HASH },
    ],
    ['size without hash', { title: 'T', visibility: 'PUBLIC', pdfSize: 10 }],
    ['empty markdown', { ...md, markdown: '' }],
    ['whitespace-only markdown', { ...md, markdown: ' \n\t ' }],
    ['markdown over 1 MiB', { ...md, markdown: 'a'.repeat(MIB + 1) }],
    [
      'multi-byte markdown over 1 MiB in bytes',
      { ...md, markdown: 'é'.repeat(MIB / 2 + 1) },
    ],
    ['pdfSize 0', { ...pdf, pdfSize: 0 }],
    ['pdfSize over 20 MiB', { ...pdf, pdfSize: 20 * MIB + 1 }],
    ['pdfSize fractional', { ...pdf, pdfSize: 10.5 }],
    ['hash uppercase', { ...pdf, pdfSha256: 'A'.repeat(64) }],
    ['hash too short', { ...pdf, pdfSha256: 'a'.repeat(63) }],
    ['empty title', { ...md, title: '' }],
    ['title of 201 characters', { ...md, title: 'a'.repeat(201) }],
    ['visibility PLATFORM', { ...md, visibility: 'PLATFORM' }],
    ['visibility other', { ...md, visibility: 'SECRET' }],
    ['productId not a uuid', { ...md, productId: 'p1' }],
    ['unknown field', { ...md, extra: 1 }],
    ['body not an object', 'markdown'],
  ])('S47 AS-17: rejects %s', (_name, body) => {
    expect(ok(knowledgeCreateRequestSchema, body)).toBe(false);
  });

  it('S47 AS-40: the admin variant has no visibility or product', () => {
    expect(
      ok(knowledgeAdminCreateRequestSchema, { title: 'Guide', markdown: 'x' }),
    ).toBe(true);
    expect(
      ok(knowledgeAdminCreateRequestSchema, {
        title: 'Guide',
        pdfSha256: HASH,
        pdfSize: 5,
      }),
    ).toBe(true);
    expect(
      ok(knowledgeAdminCreateRequestSchema, {
        title: 'Guide',
        markdown: 'x',
        visibility: 'PUBLIC',
      }),
    ).toBe(false);
    expect(
      ok(knowledgeAdminCreateRequestSchema, {
        title: 'Guide',
        markdown: 'x',
        productId: ID,
      }),
    ).toBe(false);
  });
});

describe('S47 AS-31: knowledge list query contract', () => {
  it('S47 AS-31: limit defaults to 20 and accepts 1 to 100', () => {
    expect(knowledgeListQuerySchema.parse({}).limit).toBe(20);
    expect(knowledgeListQuerySchema.parse({ limit: '2' }).limit).toBe(2);
    expect(knowledgeListQuerySchema.parse({ limit: '100' }).limit).toBe(100);
    expect(ok(knowledgeListQuerySchema, { status: 'FAILED' })).toBe(true);
    expect(ok(knowledgeListQuerySchema, { cursor: 'abc.def' })).toBe(true);
  });

  it.each(['0', '101', 'abc', '', '1.5'])(
    'S47 AS-31: rejects limit %j',
    (limit) => {
      expect(ok(knowledgeListQuerySchema, { limit })).toBe(false);
    },
  );

  it('S47 AS-31: rejects an unknown status and an unknown query field', () => {
    expect(ok(knowledgeListQuerySchema, { status: 'DELETED' })).toBe(false);
    expect(ok(knowledgeListQuerySchema, { status: 'x' })).toBe(false);
    expect(ok(knowledgeListQuerySchema, { page: '2' })).toBe(false);
  });
});

describe('S47 AS-05: ask contract', () => {
  it('S47 AS-05: the question is 3 to 500 characters after trimming', () => {
    expect(ok(ragAskRequestSchema, { question: 'abc' })).toBe(true);
    expect(ok(ragAskRequestSchema, { question: 'a'.repeat(500) })).toBe(true);
    expect(ok(ragAskRequestSchema, { question: 'ab' })).toBe(false);
    expect(ok(ragAskRequestSchema, { question: 'a'.repeat(501) })).toBe(false);
    expect(ok(ragAskRequestSchema, { question: '   ' })).toBe(false);
    expect(ok(ragAskRequestSchema, { question: '  ab  ' })).toBe(false);
    expect(ok(ragAskRequestSchema, { question: 7 })).toBe(false);
    expect(ok(ragAskRequestSchema, {})).toBe(false);
    expect(ok(ragAskRequestSchema, { question: 'abc', productId: ID })).toBe(
      false,
    );
  });
});

describe('S47 AS-01: stream event contract', () => {
  const source = {
    n: 0,
    chunkId: ID,
    documentId: ID,
    title: 'Pixel 10 manual',
    headingPath: 'Pixel 10 manual > Connectivity',
    page: null,
  };

  it('S47 AS-01: sources count from 0 and carry a heading path string', () => {
    expect(
      ok(ragStreamEventSchema, {
        event: 'sources',
        mode: 'hybrid',
        items: [source],
      }),
    ).toBe(true);
    expect(
      ok(ragStreamEventSchema, {
        event: 'sources',
        mode: 'keyword',
        items: [{ ...source, page: 3 }],
      }),
    ).toBe(true);
    expect(
      ok(ragStreamEventSchema, {
        event: 'sources',
        mode: 'hybrid',
        items: [{ ...source, n: -1 }],
      }),
    ).toBe(false);
    expect(
      ok(ragStreamEventSchema, {
        event: 'sources',
        mode: 'hybrid',
        items: [{ ...source, headingPath: ['A', 'B'] }],
      }),
    ).toBe(false);
    expect(
      ok(ragStreamEventSchema, { event: 'sources', items: [source] }),
    ).toBe(false);
  });

  it('S47 AS-12: done carries citations and grounded', () => {
    expect(
      ok(ragStreamEventSchema, {
        event: 'done',
        citations: [{ text: 'Yes', sources: [0] }],
        grounded: true,
      }),
    ).toBe(true);
    expect(ok(ragStreamEventSchema, { event: 'done', citations: [] })).toBe(
      false,
    );
  });
});
