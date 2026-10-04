import { Controller, HttpException, HttpStatus, Inject, Post, Req } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ulid } from 'ulid';
import type { CustomerImportReport } from '@leadops/types';
import {
  buildDynamicMappings,
  cleanRowDetailed,
  CleaningError,
  streamXlsx,
  type IngestSchema,
} from '@leadops/ingest-service';
import { CustomerService, type IngestRow } from './customer.service';

function loadSchema(): IngestSchema {
  const path = process.env.INGEST_SCHEMA_PATH
    ?? join(__dirname, '../../../ingest-service/configs/ingest-schema.yaml');
  const raw = readFileSync(path, 'utf8').replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] ?? '');
  return parseYaml(raw) as IngestSchema;
}

/** 批次大小：方案 B 的核心参数。1000 行是实测最平衡点，更大会撑爆 PG 事务，更小 round-trip 多。 */
const BATCH_SIZE = 1000;
/** 每批次 flush 后向 event-loop 让渡；避免长时间阻塞 TCP keep-alive。 */
const YIELD_AFTER_BATCH = true;

@Controller('customer')
export class CustomerImportController {
  constructor(@Inject(CustomerService) private readonly customers: CustomerService) {}

  @Post('import')
  async importXlsx(@Req() req: unknown): Promise<CustomerImportReport> {
    const anyReq = req as { isMultipart?: () => boolean; file?: () => Promise<unknown> };
    if (!anyReq.isMultipart?.()) {
      throw new HttpException({ code: 40001, message: 'multipart required' }, HttpStatus.BAD_REQUEST);
    }
    const file = await anyReq.file?.() as
      | { filename: string; file: NodeJS.ReadableStream }
      | undefined;
    if (!file) throw new HttpException({ code: 40001, message: 'no file' }, HttpStatus.BAD_REQUEST);
    if (!file.filename.toLowerCase().endsWith('.xlsx')) {
      throw new HttpException({ code: 40001, message: 'only xlsx supported' }, HttpStatus.BAD_REQUEST);
    }

    const baseSchema = loadSchema();
    const jobId = ulid();
    const started = Date.now();

    const report: CustomerImportReport = {
      job_id: jobId,
      file_name: file.filename,
      total_rows: 0,
      success_rows: 0,
      skipped_rows: 0,
      duplicate_rows: 0,
      written_rows: 0,
      inserted_rows: 0,
      updated_rows: 0,
      conflict_warnings: [],
      errors: [],
      elapsed_ms: 0,
    };
    const warningCount: Record<string, number> = {};

    let schema: IngestSchema = baseSchema;
    let headerParsed = false;
    let buffer: IngestRow[] = [];

    /** flush 当前批次，走 upsertBatch（方案 A+B） */
    const flush = async () => {
      if (buffer.length === 0) return;
      // 批内按 huji_no 去重（keep=last）：遵循原 schema.dedupe.key=huji_no 的语义
      const seen = new Map<string, number>();
      for (let i = 0; i < buffer.length; i++) {
        const h = buffer[i].huji_no;
        if (h) {
          const prev = seen.get(h);
          if (prev !== undefined) {
            // 后到覆盖前到
            buffer[prev] = { ...buffer[prev], ...buffer[i] };
            // 第 i 行标记为重复
            buffer.splice(i, 1);
            i--;
            report.duplicate_rows += 1;
          } else {
            seen.set(h, i);
          }
        }
      }
      const r = await this.customers.upsertBatch(buffer);
      report.inserted_rows += r.inserted;
      report.updated_rows += r.updated;
      report.written_rows += r.inserted + r.updated;
      buffer = [];
      if (YIELD_AFTER_BATCH) await new Promise((r) => setImmediate(r));
    };

    for await (const { rowNo, values } of streamXlsx(file.file as never, {
      sheetIndex: baseSchema.parse.sheet,
      skipHeaderRows: 0,
    })) {
      if (!headerParsed) {
        headerParsed = true;
        const { mappings, dropIndexes, detected } = buildDynamicMappings(values);
        if (mappings.length > 0) {
          schema = {
            ...baseSchema,
            columns: { drop_indexes: dropIndexes, mappings },
          };
          report.detected_mapping = detected.map((d) => ({ index: d.index, header: d.header, field: d.field }));
          // eslint-disable-next-line no-console
          console.log(`[import ${jobId}] dynamic mapping:`, detected.map((d) => `${d.index}[${d.header}]=>${d.field}`).join(', '));
        } else {
          // eslint-disable-next-line no-console
          console.warn(`[import ${jobId}] no header matched, fallback to schema.yaml fixed index`);
        }
        if (baseSchema.parse.skip_header_rows > 0) continue;
      }
      if (rowNo <= baseSchema.parse.skip_header_rows) continue;

      report.total_rows += 1;
      try {
        const { row, warnings } = cleanRowDetailed(values, schema, {
          source_file: file.filename,
          source_row: rowNo,
          ingest_batch: jobId,
        });
        for (const w of warnings) warningCount[w] = (warningCount[w] ?? 0) + 1;
        report.success_rows += 1;
        const normalized = Object.fromEntries(
          Object.entries(row).map(([k, v]) => [k, v === null ? undefined : v]),
        ) as unknown as IngestRow;
        buffer.push(normalized);
        if (buffer.length >= BATCH_SIZE) await flush();
      } catch (e) {
        report.skipped_rows += 1;
        const reason = e instanceof CleaningError ? e.reason : 'unknown';
        if (report.errors.length < 100) report.errors.push({ row: rowNo, reason });
      }
      if (report.total_rows % 10_000 === 0) {
        // eslint-disable-next-line no-console
        console.log(`[import ${jobId}] parsed ${report.total_rows} rows, written ${report.written_rows}, skipped ${report.skipped_rows}, elapsed=${Date.now() - started}ms`);
      }
    }

    await flush();

    report.elapsed_ms = Date.now() - started;
    report.warnings_summary = warningCount;
    // eslint-disable-next-line no-console
    console.log(`[import ${jobId}] DONE total=${report.total_rows} written=${report.written_rows} elapsed=${report.elapsed_ms}ms`);
    return report;
  }
}
