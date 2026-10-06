/**
 * Retrieval evaluation (SD-43, 10/10 #43): golden questions → expected source
 * documents → recall@k and MRR, so chunking/embedding/fusion changes are
 * measured instead of eyeballed.
 *
 *   pnpm rag:eval scripts/rag-eval/golden.json [k=6]
 *
 * Retrieval only (no LLM calls, no cost): answer quality is a separate eval.
 * Exit code 1 when recall@k drops below RAG_EVAL_MIN_RECALL (default 0.8) - CI gate.
 */
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SequelizeModule } from '@nestjs/sequelize';
import { readFileSync } from 'node:fs';
import { ApiConfigModule } from '@app/common/config/api-config.module';
import { ApiConfigService } from '@app/common/config/api-config.service';
import { RedisModule } from '@app/infrastructure/redis/redis.module';
import { KnowledgeModule, Retriever, RetrievalScope } from '@app/domains/assistant';

interface GoldenCase {
  question: string;
  scope: RetrievalScope;
  expectedDocuments: string[];
}

@Module({
  imports: [
    ApiConfigModule,
    RedisModule,
    SequelizeModule.forRootAsync({
      imports: [ApiConfigModule],
      inject: [ApiConfigService],
      useFactory: (config: ApiConfigService) => ({
        dialect: 'postgres',
        host: config.get('db_read_host') ?? config.get('db_host'),
        port: Number(config.get('db_port')),
        username: config.get('db_username'),
        password: config.get('db_password'),
        database: config.get('db_name'),
        autoLoadModels: true,
        synchronize: false,
        logging: false,
      }),
    }),
    KnowledgeModule,
  ],
})
class EvalModule {}

async function main() {
  const [file, kArg] = process.argv.slice(2);
  if (!file) throw new Error('usage: rag-eval.ts <golden.json> [k]');
  const k = Number(kArg ?? 6);
  const cases = JSON.parse(readFileSync(file, 'utf8')) as GoldenCase[];

  const app = await NestFactory.createApplicationContext(EvalModule, { logger: ['error'] });
  const retriever = app.get(Retriever);

  let hits = 0;
  let reciprocalRanks = 0;
  for (const c of cases) {
    const results = await retriever.search(c.scope, c.question, k);
    const rank = results.findIndex((r) => c.expectedDocuments.includes(r.title)) + 1;
    if (rank > 0) hits++;
    reciprocalRanks += rank > 0 ? 1 / rank : 0;
    console.log(`${rank > 0 ? '✓' : '✗'} [rank ${rank || '-'}] ${c.question}  →  ${results.map((r) => r.title).slice(0, 3).join(' | ') || '(nothing)'}`);
  }
  await app.close();

  const recall = hits / cases.length;
  console.log(`\nrecall@${k} = ${recall.toFixed(3)}   MRR = ${(reciprocalRanks / cases.length).toFixed(3)}   (${cases.length} questions)`);
  if (recall < Number(process.env.RAG_EVAL_MIN_RECALL ?? 0.8)) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
