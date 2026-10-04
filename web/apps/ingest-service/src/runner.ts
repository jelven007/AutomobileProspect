import pino from 'pino';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { ulid } from 'ulid';
import { ObjectStorage } from './storage';
import { streamXlsx } from './xlsx-stream';
import { cleanRowDetailed, CleaningError } from './pipeline';
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
  duplicateRows: number;    // 同批次身份证重复，被合并
  writtenRows: number;      // 实际入库（UPSERT 调用次数）
  conflictWarnings: number; // 兼容旧报告，身份证唯一模式下恒为 0
  checksumInvalid: number;  // 身份证 ISO7064 校验失败
  errors: Array<{ file: string; row: number; reason: string }>;
}

/**
 * 阶段 2 的 ingest 主流程。
 * 落库策略：
 *   - 清洗后立即 push 给 PgSink，内存仅保留一个数据库批次；
 *   - 批内 last-wins 与跨批次唯一由数据库 sink 统一处理。
 * 清洗告警（cleaning_error / id_card_checksum_invalid）
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
     VALUES ($1,$2,$3,'RUNNING',NOW())`,
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
          await sink.push(row);
        } catch (e) {
          if (!(e instanceof CleaningError)) throw e;
          report.skippedRows += 1;
          const reason = e.reason;
          if (report.errors.length < 100) report.errors.push({ file: obj.key, row: rowNo, reason });
          await rowLog.push({
            job_id: jobId, file: obj.key, row_no: rowNo,
            reason: 'cleaning_error', raw: { reason, values },
          });
        }
        if (report.totalRows % 10_000 === 0) {
          await sink.pool.query(
            `UPDATE ingest_job
                SET total_rows=$2, success_rows=$3, skipped_rows=$4,
                    duplicate_rows=$5, written_rows=$6, inserted_rows=$7,
                    updated_rows=$8, warnings=$9, checkpoint_row=$2,
                    updated_at=NOW()
              WHERE job_id=$1`,
            [
              jobId, report.totalRows, report.successRows, report.skippedRows,
              sink.stats.duplicateRows, sink.stats.inserted + sink.stats.updated,
              sink.stats.inserted, sink.stats.updated,
              sink.stats.conflictWarnings + report.checksumInvalid,
            ],
          );
        }
      }
    }

    await sink.flush();
    await rowLog.flush();
    report.duplicateRows = sink.stats.duplicateRows;
    report.writtenRows = sink.stats.inserted + sink.stats.updated;
    report.conflictWarnings = sink.stats.conflictWarnings;
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    await rowLog.flush().catch(() => undefined);
    await sink.pool.query(
      `UPDATE ingest_job
          SET status='FAILED', finished_at=NOW(), error=$2,
              total_rows=$3, success_rows=$4, skipped_rows=$5,
              duplicate_rows=$6, written_rows=$7, inserted_rows=$8,
              updated_rows=$9, warnings=$10, checkpoint_row=$3,
              updated_at=NOW()
        WHERE job_id=$1`,
      [jobId, errMsg, report.totalRows, report.successRows, report.skippedRows,
       sink.stats.duplicateRows, sink.stats.inserted + sink.stats.updated,
       sink.stats.inserted, sink.stats.updated,
       sink.stats.conflictWarnings + report.checksumInvalid],
    ).catch(() => undefined);
    await sink.abort().catch(() => undefined);
    throw e;
  }

  await sink.pool.query(
    `UPDATE ingest_job
        SET status='SUCCESS', finished_at=NOW(),
            total_rows=$2, success_rows=$3, skipped_rows=$4,
            duplicate_rows=$5, written_rows=$6, inserted_rows=$7,
            updated_rows=$8, warnings=$9, checkpoint_row=$2,
            report_json=$10::jsonb, updated_at=NOW()
      WHERE job_id=$1`,
    [jobId, report.totalRows, report.successRows, report.skippedRows,
     report.duplicateRows, report.writtenRows,
     sink.stats.inserted, sink.stats.updated,
     report.conflictWarnings + report.checksumInvalid,
     JSON.stringify(report)],
  );
  await sink.close();

  log.info(report, 'ingest done');
  return report;
}
