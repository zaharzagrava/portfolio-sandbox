import {
  IMPORT_FAILURE_CODES,
  IMPORT_MAX_BYTES,
  IMPORT_PROBLEM_CODES,
  IMPORT_STATUSES,
  importCompleteRequestSchema,
  importErrorReportSchema,
  importEventSchemas,
  importJobSchema,
  importListQuerySchema,
  importPageSchema,
  importProgressEventSchema,
  importStartRequestSchema,
  importStartResponseSchema,
  importUploadStateSchema,
} from './imports.ts';

const uuid = '0190a000-0000-7000-8000-000000000001';
const at = '2026-10-16T10:00:00.000Z';

const job = {
  id: uuid,
  shopId: uuid,
  status: 'DONE',
  fileName: 'catalog.csv',
  sizeBytes: 10,
  rowsProcessed: 3,
  rowsCreated: 1,
  rowsUpdated: 1,
  rowsUnchanged: 0,
  rowsFailed: 1,
  bytesProcessed: 10,
  ignoredColumns: ['colour'],
  scan: 'clean',
  failure: null,
  errorReport: { available: true, rows: 1 },
  createdBy: uuid,
  createdAt: at,
  startedAt: at,
  finishedAt: at,
  history: [{ status: 'PENDING_UPLOAD', at }],
};

describe('S07 imports contract (parse tests)', () => {
  it('S07 AS-01: the start response parses and carries no storage key', () => {
    const ok = importStartResponseSchema.safeParse({
      importId: uuid,
      status: 'PENDING_UPLOAD',
      partSize: 67_108_864,
      partCount: 1,
      parts: [{ partNumber: 1, url: 'http://storage/x?sig=1' }],
      uploadExpiresAt: at,
    });
    expect(ok.success).toBe(true);
    expect(
      importStartResponseSchema.safeParse({
        importId: uuid,
        status: 'PENDING_UPLOAD',
        partSize: 1,
        partCount: 1,
        parts: [],
        uploadExpiresAt: at,
        storageKey: 'imports/x',
      }).success,
    ).toBe(false);
  });

  it.each([
    [{ fileName: 'a.csv', sizeBytes: 1 }, true],
    [{ fileName: 'a.csv', sizeBytes: IMPORT_MAX_BYTES }, true],
    [{ fileName: 'a.csv', sizeBytes: 0 }, false],
    [{ fileName: 'a.csv', sizeBytes: -1 }, false],
    [{ fileName: 'a.csv', sizeBytes: 1.5 }, false],
    [{ fileName: 'a.csv', sizeBytes: '10' }, false],
    [{ fileName: 'a.csv', sizeBytes: IMPORT_MAX_BYTES + 1 }, false],
    [{ fileName: '', sizeBytes: 1 }, false],
    [{ fileName: 'a'.repeat(201), sizeBytes: 1 }, false],
    [{ fileName: 'a'.repeat(200), sizeBytes: 1 }, true],
    [{ fileName: 'a\u0007.csv', sizeBytes: 1 }, false],
    [{ fileName: 'a.csv', sizeBytes: 1, extra: true }, false],
  ])('S07 AS-02: start request %j parses=%s', (body, expected) => {
    expect(importStartRequestSchema.safeParse(body).success).toBe(expected);
  });

  it('S07 AS-06: the upload state parses', () => {
    expect(
      importUploadStateSchema.safeParse({
        importId: uuid,
        partSize: 67_108_864,
        partCount: 3,
        uploaded: [{ partNumber: 1, etag: 'e', sizeBytes: 5 }],
        missing: [{ partNumber: 2, url: 'http://s/x' }],
        uploadExpiresAt: at,
      }).success,
    ).toBe(true);
  });

  // Only the shape is a contract matter; an empty list, part 0 or an empty ETag parse and are 422 invalid_parts (AS-08).
  it.each([
    [{ parts: [{ partNumber: 1, etag: 'a' }] }, true],
    [{ parts: [] }, true],
    [{ parts: [{ partNumber: 0, etag: 'a' }] }, true],
    [{ parts: [{ partNumber: 1, etag: '' }] }, true],
    [{ parts: [{ partNumber: 1.5, etag: 'a' }] }, false],
    [{ parts: [{ partNumber: '1', etag: 'a' }] }, false],
    [{ parts: [{ partNumber: 1 }] }, false],
    [{ parts: [{ partNumber: 1, etag: 'a', extra: 1 }] }, false],
    [{}, false],
  ])('S07 AS-08: complete request %j parses=%s', (body, expected) => {
    expect(importCompleteRequestSchema.safeParse(body).success).toBe(expected);
  });

  it('S07 AS-51: the job view parses and refuses internals', () => {
    expect(importJobSchema.safeParse(job).success).toBe(true);
    for (const extra of [
      'storageKey',
      'uploadHandle',
      'leaseHolder',
      'leaseExpiresAt',
      'cancelRequestedAt',
      'lastEnqueuedAt',
      'slot',
      'url',
    ])
      expect(
        importJobSchema.safeParse({ ...job, [extra]: 'x' }).success,
      ).toBe(false);
    expect(
      importJobSchema.safeParse({
        ...job,
        status: 'FAILED',
        failure: { code: 'malware_detected', message: 'The file was refused.', detail: null },
      }).success,
    ).toBe(true);
    expect(
      importJobSchema.safeParse({
        ...job,
        failure: { code: 'nope', message: 'x', detail: null },
      }).success,
    ).toBe(false);
  });

  it('S07 AS-54: the page and the list query parse', () => {
    const { history: _history, ...item } = job;
    expect(
      importPageSchema.safeParse({ items: [item], nextCursor: null }).success,
    ).toBe(true);
    expect(importListQuerySchema.parse({}).limit).toBe(20);
    for (const bad of [
      { limit: '0' },
      { limit: '101' },
      { limit: 'abc' },
      { status: 'NOPE' },
      { cursor: '' },
    ])
      expect(importListQuerySchema.safeParse(bad).success).toBe(false);
    expect(
      importListQuerySchema.parse({ status: 'DONE', limit: '5' }),
    ).toEqual({ status: 'DONE', limit: 5 });
  });

  it('S07 AS-29: the error report parses', () => {
    expect(
      importErrorReportSchema.safeParse({
        url: 'http://usercontent.example/x?sig=1',
        expiresAt: at,
        rows: 3,
      }).success,
    ).toBe(true);
  });

  it('S07 AS-55: progress events are discriminated', () => {
    for (const e of [
      { type: 'progress', processed: 5, failed: 1, bytesProcessed: 9, sizeBytes: 10 },
      { type: 'done', rowsProcessed: 5, rowsFailed: 1 },
      { type: 'failed', code: 'malware_detected' },
      { type: 'cancelled' },
    ])
      expect(importProgressEventSchema.safeParse(e).success).toBe(true);
    expect(importProgressEventSchema.safeParse({ type: 'other' }).success).toBe(
      false,
    );
    expect(
      importProgressEventSchema.safeParse({ type: 'failed', code: 'x' }).success,
    ).toBe(false);
  });

  it('S07 AS-64: the finished event payload parses', () => {
    const payload = {
      importId: uuid,
      shopId: uuid,
      createdBy: uuid,
      status: 'FAILED',
      failureCode: 'malware_detected',
      rowsProcessed: 0,
      rowsCreated: 0,
      rowsUpdated: 0,
      rowsUnchanged: 0,
      rowsFailed: 0,
      startedAt: null,
      finishedAt: at,
    };
    const schema = importEventSchemas['catalogsync.import_finished'];
    expect(schema.safeParse(payload).success).toBe(true);
    expect(schema.safeParse({ ...payload, status: 'PROCESSING' }).success).toBe(
      false,
    );
    expect(schema.safeParse({ ...payload, extra: 1 }).success).toBe(false);
  });

  it('S07 AS-58: the closed lists have the documented sizes', () => {
    expect(IMPORT_STATUSES).toHaveLength(8);
    expect(IMPORT_FAILURE_CODES).toHaveLength(10);
    expect(IMPORT_PROBLEM_CODES).toEqual(
      expect.arrayContaining([
        'invalid_parts',
        'size_mismatch',
        'too_many_active_imports',
        'import_not_found',
      ]),
    );
  });
});
