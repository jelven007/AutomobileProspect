import pino from 'pino';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { ulid } from 'ulid';
import { ObjectStorage } from './storage';
import { streamXlsx } from './xlsx-stream';
import { cleanRowDetailed, CleaningError, RowDeduper } from './pipeline';
import { PgSink, RowLogSink } from './sink';
import type { IngestSchema } from './types';

const log = pino({ name: 'ingest' });

export function loadSchema(path: string): IngestSchema {
  const raw = readFileSync(path, 'utf8').replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] ?? '');
  return parseYaml(raw) as IngestSchema;
}

export interface ListOptions {
  schemaPath: string;
  prefix?: string;
}

export interface ListReport {
  bucket: string;
  prefix: string;
  sourceType: string;
  endpoint?: string;
  region?: string;
  files: Array<{ key: string; size: number; etag: string; lastModified?: Date }>;
  totalBytes: number;
}

/** 仅列出 TOS/S3 前缀下的 xlsx 文件，不触碰 PG。用于估算文件数与大小。 */
export async function listSources(opts: ListOptions): Promise<ListReport> {
  const schema = loadSchema(opts.schemaPath);
  const prefix = opts.prefix ?? schema.source.prefix;
  const storage = new ObjectStorage(schema.source.bucket, {
    endpoint: schema.source.endpoint,
    region: schema.source.region,
    forcePathStyle: schema.source.force_path_style,
  });
  const files: ListReport['files'] = [];
  let totalBytes = 0;
  for await (const obj of storage.list(prefix)) {
    files.push(obj);
    totalBytes += obj.size;
  }
  return {
    bucket: schema.source.bucket,
    prefix,
    sourceType: schema.source.type,
    endpoint: schema.source.endpoint,
    region: schema.source.region,
    files,
    totalBytes,
  };
}

export interface RunOptions {
  schemaPath: string;
  prefix?: string;
  pgUrl: string;
}

export interface RunReport {
  jobId: string;
  files: number;
  totalRows: number;
  successRows: number;      // 清洗通过（去重前）
  skippedRows: number;      // 清洗失败
  duplicateRows: number;    // 同批次 huji_no 重复，被合并
  writtenRows: number;      // 实际入库（UPSERT 调用次数）
  conflictWarnings: number; // 身份证相同但 huji_no 不同
  checksumInvalid: number;  // 身份证 ISO7064 校验失败
  errors: Array<{ file: string; row: number; reason: string }>;
}

/**
 * 阶段 2 的 ingest 主流程。
 * 落库策略：
 *   - 无 dedupe：清洗后立即 push 给 PgSink，内存不积累（阶段 2.3）
 *   - 有 dedupe：按 huji_no 去重后统一 flush，兼容 last-wins 语义
 * 三类告警（cleaning_error / id_card_conflict / id_card_checksum_invalid）
 * 统一通过 RowLogSink 写入 ingest_row_log，便于后续运营看板。
 */
export async function runIngest(opts: RunOptions): Promise<RunReport> {
  const schema = loadSchema(opts.schemaPath);
  const prefix = opts.prefix ?? schema.source.prefix;
  const storage = new ObjectStorage(schema.source.bucket, {
    endpoint: schema.source.endpoint,
    region: schema.source.region,
    forcePathStyle: schema.source.force_path_style,
  });
  const sink = new PgSink(opts.pgUrl, schema.sink.batch_size);
  const rowLog = new RowLogSink(sink.pool);
  const deduper = schema.dedupe ? new RowDeduper(schema.dedupe) : null;

  const jobId = ulid();
  const report: RunReport = {
    jobId, files: 0, totalRows: 0, successRows: 0, skippedRows: 0,
    duplicateRows: 0, writtenRows: 0, conflictWarnings: 0, checksumInvalid: 0, errors: [],
  };

  log.info({
    jobId,
    source_type: schema.source.type,
    bucket: schema.source.bucket,
    endpoint: schema.source.endpoint,
    region: schema.source.region,
    prefix,
  }, 'ingest start');

  // ingest_job 开始行：便于看板实时追踪进度；finally 块里补 finished_at + stats
  await sink.pool.query(
    `INSERT INTO ingest_job (job_id, source_bucket, source_prefix, status, started_at)
     VALUES ($1,$2,$3,'running',NOW())`,
    [jobId, schema.source.bucket, prefix],
  );

  try {
    for await (const obj of storage.list(prefix)) {
      report.files += 1;
      log.info({ jobId, file: obj.key }, 'processing file');
      const body = await storage.open(obj.key);
      for await (const { rowNo, values } of streamXlsx(body, {
        sheetIndex: schema.parse.sheet,
        skipHeaderRows: schema.parse.skip_header_rows,
      })) {
        report.totalRows += 1;
        try {
          const { row, warnings } = cleanRowDetailed(values, schema, {
            source_file: obj.key,
            source_row: rowNo,
            ingest_batch: jobId,
          });
          report.successRows += 1;
          for (const w of warnings) {
            if (w === 'id_card_checksum_invalid') report.checksumInvalid += 1;
            await rowLog.push({ job_id: jobId, file: obj.key, row_no: rowNo, reason: w });
          }
          if (deduper) {
            const added = deduper.add(row);
            if (!added) report.duplicateRows += 1;
          } else {
            await sink.push(row);
            report.writtenRows += 1;
          }
        } catch (e) {
          report.skippedRows += 1;
          const reason = e instanceof CleaningError ? e.reason : 'unknown';
          if (report.errors.length < 100) report.errors.push({ file: obj.key, row: rowNo, reason });
          await rowLog.push({
            job_id: jobId, file: obj.key, row_no: rowNo,
            reason: 'cleaning_error', raw: { reason, values },
          });
        }
      }
    }

    if (deduper) {
      for (const r of deduper.values()) {
        await sink.push(r);
        report.writtenRows += 1;
      }
      report.conflictWarnings = deduper.warnings.length;
      for (const w of deduper.warnings) {
        await rowLog.push({
          job_id: jobId,
          file: w.row.source_file,
          row_no: w.row.source_row,
          reason: w.reason,
          raw: { against_huji_no: w.against, this_huji_no: w.row.huji_no },
        });
      }
    }

    await rowLog.flush();
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    await sink.pool.query(
      `UPDATE ingest_job
          SET status='failed', finished_at=NOW(), error=$2,
              total_rows=$3, success_rows=$4, skipped_rows=$5,
              duplicate_rows=$6, written_rows=$7, warnings=$8
        WHERE job_id=$1`,
      [jobId, errMsg, report.totalRows, report.successRows, report.skippedRows,
       report.duplicateRows, report.writtenRows,
       report.conflictWarnings + report.checksumInvalid],
    ).catch(() => undefined);
    await sink.close().catch(() => undefined);
    throw e;
  }

  await sink.pool.query(
    `UPDATE ingest_job
        SET status='succeeded', finished_at=NOW(),
            total_rows=$2, success_rows=$3, skipped_rows=$4,
            duplicate_rows=$5, written_rows=$6, warnings=$7
      WHERE job_id=$1`,
    [jobId, report.totalRows, report.successRows, report.skippedRows,
     report.duplicateRows, report.writtenRows,
     report.conflictWarnings + report.checksumInvalid],
  );
  await sink.close();

  log.info(report, 'ingest done');
  return report;
}
