import { HttpResponse } from 'msw';

/**
 * A problem+json answer for a code that `sellerProblem` does not list (finance, import and export codes). The `title` and
 * `detail` are bait: a screen that shows either fails its test. `extra` adds top-level members (`activeExportId`).
 */
export function problemResponse(code: string, status: number, extra: Record<string, unknown> = {}): Response {
  return HttpResponse.json(
    {
      type: `https://marketplace.example/problems/${code}`,
      title: 'Server title that the UI must never show',
      status,
      detail: 'Server detail that the UI must never show',
      instance: '/test',
      code,
      requestId: 'req-seller-f',
      ...extra,
    },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}
