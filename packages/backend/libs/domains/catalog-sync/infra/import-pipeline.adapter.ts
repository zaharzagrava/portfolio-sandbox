import { Injectable } from '@nestjs/common';
import type {
  ImportPipelinePort,
  ImportPipelineRun,
  ParsedRecord,
} from '../domain/ports';
import { parseStage } from './import-parse-stage';
import { runImportPipeline } from './import-pipeline';

/** The Node streams side of the import: the file's bytes through the lazy parse stage into the batch writer. */
@Injectable()
export class ImportPipelineAdapter implements ImportPipelinePort {
  run(options: ImportPipelineRun): Promise<void> {
    return runImportPipeline<ParsedRecord>({
      source: options.source,
      signal: options.signal,
      stages: [
        parseStage({
          format: options.format,
          startOffset: options.startOffset,
          startRow: options.startRow,
          header: options.header,
          onHeader: options.onHeader,
          onKeys: options.onKeys,
        }),
      ],
      consume: (records) => options.consume(records),
    });
  }
}
