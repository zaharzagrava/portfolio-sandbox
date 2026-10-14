/**
 * Retrieval evaluation (S47 FR-027, AS-49; SD-43 10/10 #43): golden questions → expected source documents → recall@k and
 * MRR, so chunking, embedding and fusion changes are measured instead of eyeballed.
 *
 *   pnpm rag:eval scripts/rag-eval/golden.json [k=6]
 *   pnpm rag:eval --golden scripts/rag-eval/golden.json --k 6
 *
 * Retrieval only (no model call, no cost): answer quality is a separate eval. Exit codes:
 *   0  recall@k at or above RAG_EVAL_MIN_RECALL (default 0.8)
 *   1  recall@k below it (the CI release gate)
 *   2  the golden file is malformed - the message names the offending case (checked before anything boots)
 */
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { readFileSync } from 'node:fs';
import { ApiConfigModule } from '@app/common/config/api-config.module';
import { ApiConfigService } from '@app/common/config/api-config.service';
import { RequestContextModule } from '@app/infrastructure/context/request-context.module';
import { TransactionModule } from '@app/infrastructure/context/transaction.module';
import { DatabaseModule } from '@app/infrastructure/database';
import { RedisModule } from '@app/infrastructure/redis/redis.module';
import {
  evaluateRetrieval,
  KnowledgeSearchModule,
  KnowledgeSearchService,
  type EvalReport,
  type RetrievalScope,
} from '@app/domains/assistant';

export const EXIT = { ok: 0, belowMinimum: 1, malformed: 2 } as const;
export const DEFAULT_K = 6;

export interface GoldenCase {
  question: string;
  scope: RetrievalScope;
  /** Titles or ids of the documents at least one of which a good search finds. */
  expectedDocuments: string[];
}

export class GoldenFileError extends Error {
  constructor(
    message: string,
    /** Index of the offending case, `null` for a problem with the file as a whole. */
    readonly caseIndex: number | null,
  ) {
    super(message);
    this.name = 'GoldenFileError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Parses and validates the golden file. Throws `GoldenFileError` naming the first offending case. */
export function parseGolden(raw: string): GoldenCase[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new GoldenFileError('the golden file is not valid JSON', null);
  }
  if (!Array.isArray(parsed) || parsed.length === 0)
    throw new GoldenFileError(
      'the golden file must be a non-empty array of cases',
      null,
    );
  return parsed.map((c, index): GoldenCase => {
    const fail = (why: string): never => {
      throw new GoldenFileError(`case ${index}: ${why}`, index);
    };
    if (!isRecord(c)) return fail('is not an object');
    if (typeof c.question !== 'string' || !c.question.trim())
      fail('question must be a non-empty string');
    const scope = c.scope;
    if (!isRecord(scope)) return fail('scope must be an object');
    if (scope.kind === 'product') {
      if (typeof scope.productId !== 'string' || !UUID.test(scope.productId))
        fail('scope.productId must be a UUID');
      if (typeof scope.shopId !== 'string' || !UUID.test(scope.shopId))
        fail('scope.shopId must be a UUID');
    } else if (scope.kind === 'shop') {
      if (typeof scope.shopId !== 'string' || !UUID.test(scope.shopId))
        fail('scope.shopId must be a UUID');
    } else fail('scope.kind must be "product" or "shop"');
    if (
      !Array.isArray(c.expectedDocuments) ||
      c.expectedDocuments.length === 0 ||
      !c.expectedDocuments.every((d) => typeof d === 'string' && d.trim())
    )
      fail('expectedDocuments must be a non-empty array of strings');
    return c as unknown as GoldenCase;
  });
}

export type SearchFn = (
  scope: RetrievalScope,
  question: string,
  options: { k: number },
) => Promise<{ items: { title: string; documentId: string }[] }>;

export interface EvalRun {
  exitCode: (typeof EXIT)[keyof typeof EXIT];
  report: EvalReport;
}

/** Runs every case through `search` (retrieval only), prints one line per case and the totals, and decides the exit code. */
export async function runEval(input: {
  cases: GoldenCase[];
  k: number;
  minRecall: number;
  search: SearchFn;
  log: (line: string) => void;
}): Promise<EvalRun> {
  const { cases, k, minRecall, search, log } = input;
  const scored: { retrieved: string[]; expected: string[] }[] = [];
  for (const c of cases) {
    const { items } = await search(c.scope, c.question, { k });
    const expected = new Set(c.expectedDocuments);
    // A retrieved passage is identified by the document id when that is what the case expects, else by its title.
    const retrieved = items.map((i) =>
      expected.has(i.documentId) ? i.documentId : i.title,
    );
    scored.push({ retrieved, expected: c.expectedDocuments });
    const rank = retrieved.findIndex((id) => expected.has(id)) + 1;
    log(
      `${rank > 0 ? '✓' : '✗'} [rank ${rank || '-'}] ${c.question}  →  ${
        items
          .map((i) => i.title)
          .slice(0, 3)
          .join(' | ') || '(nothing)'
      }`,
    );
  }
  const report = evaluateRetrieval(scored, k);
  log(
    `\nrecall@${k} = ${report.recallAtK.toFixed(3)}   MRR = ${report.mrr.toFixed(3)}   (${report.cases} questions)`,
  );
  return {
    exitCode: report.recallAtK < minRecall ? EXIT.belowMinimum : EXIT.ok,
    report,
  };
}

/** The minimal application the harness boots: the database, Redis and the retrieval module - no controller, no limiter. */
@Module({
  imports: [
    ApiConfigModule,
    RequestContextModule,
    TransactionModule,
    DatabaseModule,
    RedisModule,
    KnowledgeSearchModule,
  ],
})
export class EvalModule {}

export function parseArgs(argv: string[]): { file?: string; k: number } {
  const positional: string[] = [];
  let file: string | undefined;
  let k = DEFAULT_K;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--golden') file = argv[++i];
    else if (argv[i] === '--k') k = Number(argv[++i]);
    else if (argv[i] !== '--') positional.push(argv[i]);
  }
  file ??= positional[0];
  if (positional[1] !== undefined && !argv.includes('--k'))
    k = Number(positional[1]);
  return { file, k };
}

export async function main(argv: string[]): Promise<number> {
  const { file, k } = parseArgs(argv);
  if (!file || !Number.isInteger(k) || k < 1 || k > 20) {
    console.error(
      'usage: rag-eval.ts <golden.json> [k]   (k is an integer from 1 to 20)',
    );
    return EXIT.malformed;
  }
  let cases: GoldenCase[];
  try {
    cases = parseGolden(readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(
      error instanceof GoldenFileError
        ? `malformed golden file: ${error.message}`
        : `cannot read the golden file: ${(error as Error).message}`,
    );
    return EXIT.malformed;
  }

  const app = await NestFactory.createApplicationContext(EvalModule, {
    logger: ['error'],
  });
  try {
    const search = app.get(KnowledgeSearchService);
    const { exitCode } = await runEval({
      cases,
      k,
      minRecall: app.get(ApiConfigService).get('rag_eval_min_recall'),
      search: (scope, question, options) =>
        search.search(scope, question, options),
      log: (line) => console.log(line),
    });
    return exitCode;
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
