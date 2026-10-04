import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  OnModuleInit,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parse as parseYaml } from 'yaml';
import { readFileSync } from 'node:fs';
import { ulid } from 'ulid';
import type { CustomerImportReport } from '@leadops/types';
import type { Prisma } from '@prisma/client';
import {
  buildDynamicMappings,
  cleanRowDetailed,
  CleaningError,
  streamXlsx,
  type IngestSchema,
} from '@leadops/ingest-service';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerService, type IngestRow } from './customer.service';

const BATCH_SIZE = 1000;

function loadSchema(): IngestSchema {
  const path = process.env.INGEST_SCHEMA_PATH
    ?? join(__dirname, '../../../ingest-service/configs/ingest-schema.yaml');
  const raw = readFileSync(path, 'utf8').replace(/\$\{(\w+)\}/g, (_, key) => process.env[key] ?? '');
  return parseYaml(raw) as IngestSchema;
}

function asNumber(value: bigint | number): number {
  return typeof value === 'bigint' ? Number(value) : value;
}

@Injectable()
export class CustomerImportService implements OnModuleInit {
  private activeJobs = 0;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CustomerService) private readonly customers: CustomerService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.prisma.ingestJob.updateMany({
      where: { status: 'RUNNING', file_path: { not: null } },
      data: {
        status: 'FAILED',
        error: 'process_interrupted_retry_available',
        finished_at: new Date(),
        updated_at: new Date(),
      },
    });
  }

  async importFile(filename: string, input: Readable): Promise<CustomerImportReport> {
    return this.withSlot(async () => {
      const jobId = ulid();
      const importDir = join(process.env.DATA_DIR ?? join(process.cwd(), '.data'), 'imports');
      await mkdir(importDir, { recursive: true });
      const filePath = join(importDir, `${jobId}.xlsx`);
      const hash = createHash('sha256');
      const hashingStream = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          hash.update(chunk);
          callback(null, chunk);
        },
      });

      try {
        await pipeline(input, hashingStream, createWriteStream(filePath, { flags: 'wx', mode: 0o600 }));
      } catch (error) {
        await rm(filePath, { force: true });
        throw error;
      }

      const fileHash = hash.digest('hex');
      const existing = await this.prisma.ingestJob.findFirst({
        where: { file_hash: fileHash, status: 'SUCCESS' },
        orderBy: { finished_at: 'desc' },
      });
      if (existing?.report_json) {
        await rm(filePath, { force: true });
        return existing.report_json as unknown as CustomerImportReport;
      }

      await this.prisma.ingestJob.create({
        data: {
          job_id: jobId,
          file_name: filename,
          file_path: filePath,
          file_hash: fileHash,
          status: 'PENDING',
        },
      });
      return this.processJob(jobId);
    });
  }

  async retry(jobId: string): Promise<void> {
    const job = await this.prisma.ingestJob.findUnique({ where: { job_id: jobId } });
    if (!job) {
      throw new HttpException({ code: 40401, message: 'not_found' }, HttpStatus.NOT_FOUND);
    }
    if (job.status !== 'FAILED') {
      throw new HttpException(
        { code: 40902, message: 'only_failed_jobs_can_retry' },
        HttpStatus.CONFLICT,
      );
    }
    if (!job.file_path) {
      throw new HttpException({ code: 40903, message: 'job_file_unavailable' }, HttpStatus.CONFLICT);
    }
    await this.prisma.ingestJob.update({
      where: { job_id: jobId },
      data: { status: 'PENDING', error: null, updated_at: new Date() },
    });
    setImmediate(() => {
      void this.withSlot(() => this.processJob(jobId)).catch(async (error) => {
        await this.prisma.ingestJob.update({
          where: { job_id: jobId },
          data: {
            status: 'FAILED',
            error: error instanceof Error ? error.message : String(error),
            finished_at: new Date(),
            updated_at: new Date(),
          },
        });
      });
    });
  }

  private async withSlot<T>(work: () => Promise<T>): Promise<T> {
    const limit = Math.max(1, Number(process.env.IMPORT_CONCURRENCY ?? 1));
    if (this.activeJobs >= limit) {
      throw new HttpException(
        { code: 42901, message: 'import_concurrency_limit' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    this.activeJobs += 1;
    try {
      return await work();
    } finally {
      this.activeJobs -= 1;
    }
  }

  private async processJob(jobId: string): Promise<CustomerImportReport> {
    const job = await this.prisma.ingestJob.findUniqueOrThrow({ where: { job_id: jobId } });
    if (!job.file_path || !job.file_name) {
      throw new Error('ingest_job_file_missing');
    }

    const baseSchema = loadSchema();
    const started = Date.now();
    const report: CustomerImportReport = {
      job_id: jobId,
      file_name: job.file_name,
      total_rows: 0,
      success_rows: 0,
      skipped_rows: 0,
      duplicate_rows: 0,
      written_rows: asNumber(job.inserted_rows) + asNumber(job.updated_rows),
      inserted_rows: asNumber(job.inserted_rows),
      updated_rows: asNumber(job.updated_rows),
      conflict_warnings: [],
      errors: [],
      elapsed_ms: 0,
    };
    const warningCount: Record<string, number> = {};

    await this.prisma.ingestJob.update({
      where: { job_id: jobId },
      data: {
        status: 'RUNNING',
        total_rows: 0,
        success_rows: 0,
        skipped_rows: 0,
        duplicate_rows: 0,
        checkpoint_row: 0,
        warnings: 0,
        error: null,
        started_at: new Date(),
        finished_at: null,
        updated_at: new Date(),
      },
    });

    let schema = baseSchema;
    let headerParsed = false;
    let buffer: IngestRow[] = [];
    let committedRow = 0;

    const flush = async () => {
      if (buffer.length === 0) return;
      const byIdCard = new Map<string, IngestRow>();
      for (const row of buffer) {
        const idCard = row.id_card?.trim().toUpperCase();
        if (!idCard) throw new Error('id_card_required_after_cleaning');
        if (byIdCard.has(idCard)) report.duplicate_rows += 1;
        byIdCard.set(idCard, { ...row, id_card: idCard });
      }
      const batch = [...byIdCard.values()];
      const result = await this.customers.upsertBatch(batch, {
        jobId,
        totalRows: report.total_rows,
        successRows: report.success_rows,
        skippedRows: report.skipped_rows,
        duplicateRows: report.duplicate_rows,
        insertedBeforeBatch: report.inserted_rows,
        updatedBeforeBatch: report.updated_rows,
        warnings: Object.values(warningCount).reduce((sum, count) => sum + count, 0),
        checkpointRow: report.total_rows,
      });
      buffer = [];
      committedRow = report.total_rows;
      report.inserted_rows += result.inserted;
      report.updated_rows += result.updated;
      report.written_rows = report.inserted_rows + report.updated_rows;
      report.conflict_warnings.push(
        ...result.conflicts.slice(0, Math.max(0, 100 - report.conflict_warnings.length)),
      );
      await new Promise((resolve) => setImmediate(resolve));
    };

    try {
      for await (const { rowNo, values } of streamXlsx(createReadStream(job.file_path), {
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
            report.detected_mapping = detected.map((item) => ({
              index: item.index,
              header: item.header,
              field: item.field,
            }));
          }
          if (baseSchema.parse.skip_header_rows > 0) continue;
        }
        if (rowNo <= baseSchema.parse.skip_header_rows) continue;

        report.total_rows += 1;
        try {
          const { row, warnings } = cleanRowDetailed(values, schema, {
            source_file: job.file_name,
            source_row: rowNo,
            ingest_batch: jobId,
          });
          for (const warning of warnings) {
            warningCount[warning] = (warningCount[warning] ?? 0) + 1;
          }
          report.success_rows += 1;
          buffer.push(Object.fromEntries(
            Object.entries(row).map(([key, value]) => [key, value === null ? undefined : value]),
          ) as unknown as IngestRow);
          if (buffer.length >= BATCH_SIZE) await flush();
        } catch (error) {
          if (!(error instanceof CleaningError)) throw error;
          report.skipped_rows += 1;
          if (report.errors.length < 100) {
            report.errors.push({ row: rowNo, reason: error.reason });
          }
        }
      }

      await flush();
      report.elapsed_ms = Date.now() - started;
      report.warnings_summary = warningCount;
      await this.prisma.ingestJob.update({
        where: { job_id: jobId },
        data: {
          status: 'SUCCESS',
          total_rows: report.total_rows,
          success_rows: report.success_rows,
          skipped_rows: report.skipped_rows,
          duplicate_rows: report.duplicate_rows,
          written_rows: report.written_rows,
          inserted_rows: report.inserted_rows,
          updated_rows: report.updated_rows,
          warnings: Object.values(warningCount).reduce((sum, count) => sum + count, 0),
          warnings_json: warningCount as Prisma.InputJsonValue,
          report_json: report as unknown as Prisma.InputJsonValue,
          checkpoint_row: report.total_rows,
          finished_at: new Date(),
          updated_at: new Date(),
        },
      });
      return report;
    } catch (error) {
      report.elapsed_ms = Date.now() - started;
      await this.prisma.ingestJob.update({
        where: { job_id: jobId },
        data: {
          status: 'FAILED',
          total_rows: report.total_rows,
          success_rows: report.success_rows,
          skipped_rows: report.skipped_rows,
          duplicate_rows: report.duplicate_rows,
          written_rows: report.written_rows,
          inserted_rows: report.inserted_rows,
          updated_rows: report.updated_rows,
          checkpoint_row: committedRow,
          error: error instanceof Error ? error.message : String(error),
          finished_at: new Date(),
          updated_at: new Date(),
        },
      });
      throw error;
    }
  }
}
