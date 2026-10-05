import { HttpException, HttpStatus, Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import archiver from 'archiver';
import ExcelJS from 'exceljs';
import { ulid } from 'ulid';
import type { Customer, CustomerListQuery, ExportJob } from '@leadops/types';
import type { Prisma } from '@prisma/client';
import { DOCUMENT_TYPES, type DocumentType } from '@leadops/ingest-service';
import { PrismaService } from '../prisma/prisma.service';
import { customerWhere } from './customer-filters';

const EXPORT_COLUMNS: Array<{ header: string; key: keyof Customer; width: number }> = [
  { header: '编码编号', key: 'huji_no', width: 18 },
  { header: '姓名', key: 'name', width: 10 },
  { header: '证件类型', key: 'id_type', width: 26 },
  { header: '证件号码', key: 'id_card', width: 20 },
  { header: '出生日期', key: 'birth_date', width: 12 },
  { header: '性别', key: 'gender', width: 6 },
  { header: '手机号', key: 'phone_masked', width: 14 },
  { header: '省份', key: 'province', width: 10 },
  { header: '城市', key: 'city', width: 10 },
  { header: '区县', key: 'district', width: 12 },
  { header: '地址', key: 'address', width: 32 },
  { header: '职业', key: 'occupation', width: 12 },
  { header: '学历', key: 'education', width: 10 },
  { header: '婚姻', key: 'marital_status', width: 8 },
  { header: '统计时间', key: 'stat_time', width: 12 },
  { header: '入库批次', key: 'ingest_batch', width: 20 },
];

interface ResidentExportGroup {
  province: string | null;
  city: string | null;
  _count: { _all: number };
}

class ExportPauseRequested extends Error {
  constructor() {
    super('export_pause_requested');
  }
}

class ExportOwnershipLost extends Error {
  constructor() {
    super('export_ownership_lost');
  }
}

export interface ExportFilePlan {
  kind: 'resident_city' | 'non_resident';
  archiveName: string;
  count: number;
  province?: string | null;
  city?: string | null;
}

export function buildExportFilePlans(
  residentGroups: ResidentExportGroup[],
  nonResidentCount: number,
): ExportFilePlan[] {
  const plans: ExportFilePlan[] = residentGroups.map((group) => {
    const province = group.province ?? '未知省份';
    const city = group.city ?? '未知城市';
    const archiveName = `${province}-${city}-${group._count._all}条.xlsx`.replace(/[\\/:*?"<>|]/g, '_');
    return {
      kind: 'resident_city',
      archiveName,
      count: group._count._all,
      province: group.province,
      city: group.city,
    };
  });
  if (nonResidentCount > 0) {
    plans.push({
      kind: 'non_resident',
      archiveName: `非居民身份证-${nonResidentCount}条.xlsx`,
      count: nonResidentCount,
    });
  }
  return plans;
}

function serializeJob(job: {
  job_id: string;
  status: string;
  file_name: string | null;
  total_rows: bigint;
  processed_rows: bigint;
  groups: number;
  completed_groups: number;
  filters: Prisma.JsonValue;
  requested_by: string | null;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  expires_at: Date | null;
}): ExportJob {
  return {
    job_id: job.job_id,
    status: job.status as ExportJob['status'],
    file_name: job.file_name ?? undefined,
    total_rows: Number(job.total_rows),
    processed_rows: Number(job.processed_rows),
    groups: job.groups,
    completed_groups: job.completed_groups,
    filters: job.filters as CustomerListQuery,
    requested_by: job.requested_by ?? undefined,
    error: job.error ?? undefined,
    created_at: job.created_at.toISOString(),
    started_at: job.started_at?.toISOString(),
    finished_at: job.finished_at?.toISOString(),
    expires_at: job.expires_at?.toISOString(),
  };
}

@Injectable()
export class CustomerExportService implements OnModuleInit {
  private readonly active = new Set<string>();
  private readonly pauseRequests = new Set<string>();
  private readonly queue: string[] = [];
  private draining = false;

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    const pausing = await this.prisma.exportJob.findMany({
      where: { status: 'PAUSING' },
      select: { job_id: true },
    });
    if (pausing.length > 0) {
      await this.prisma.exportJob.updateMany({
        where: { job_id: { in: pausing.map((job) => job.job_id) }, status: 'PAUSING' },
        data: { status: 'PAUSED' },
      });
      await Promise.all(pausing.map((job) => this.cleanupArtifacts(job.job_id)));
    }
    const interrupted = await this.prisma.exportJob.findMany({
      where: { status: { in: ['PENDING', 'RUNNING'] } },
      select: { job_id: true },
      orderBy: { created_at: 'asc' },
    });
    if (interrupted.length > 0) {
      await this.prisma.exportJob.updateMany({
        where: { job_id: { in: interrupted.map((job) => job.job_id) } },
        data: { status: 'PENDING', started_at: null },
      });
    }
    for (const job of interrupted) this.schedule(job.job_id);
  }

  async create(filters: CustomerListQuery, requestedBy: string): Promise<ExportJob> {
    const job = await this.prisma.exportJob.create({
      data: {
        job_id: ulid(),
        status: 'PENDING',
        filters: filters as Prisma.InputJsonValue,
        requested_by: requestedBy,
      },
    });
    this.schedule(job.job_id);
    return serializeJob(job);
  }

  async get(jobId: string): Promise<ExportJob | null> {
    const job = await this.prisma.exportJob.findUnique({ where: { job_id: jobId } });
    return job ? serializeJob(job) : null;
  }

  async list(limit = 100): Promise<ExportJob[]> {
    const jobs = await this.prisma.exportJob.findMany({
      orderBy: { created_at: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
    return jobs.map(serializeJob);
  }

  async getDownload(jobId: string): Promise<{ path: string; filename: string } | null> {
    const job = await this.prisma.exportJob.findUnique({ where: { job_id: jobId } });
    if (!job || job.status !== 'SUCCESS' || !job.file_path || !job.file_name) return null;
    if (job.expires_at && job.expires_at < new Date()) return null;
    return { path: job.file_path, filename: job.file_name };
  }

  async pause(jobId: string): Promise<ExportJob | null> {
    const job = await this.prisma.exportJob.findUnique({ where: { job_id: jobId } });
    if (!job) return null;
    if (job.status === 'PAUSED' || job.status === 'PAUSING') return serializeJob(job);
    if (job.status === 'PENDING') {
      const paused = await this.prisma.exportJob.updateMany({
        where: { job_id: jobId, status: 'PENDING' },
        data: { status: 'PAUSED' },
      });
      if (paused.count === 0) return this.pause(jobId);
      this.removeFromQueue(jobId);
      await this.cleanupArtifacts(jobId);
      return this.get(jobId);
    }
    if (job.status === 'RUNNING') {
      this.pauseRequests.add(jobId);
      const pausing = await this.prisma.exportJob.updateMany({
        where: { job_id: jobId, status: 'RUNNING' },
        data: { status: 'PAUSING' },
      });
      if (pausing.count === 0) {
        this.pauseRequests.delete(jobId);
        return this.pause(jobId);
      }
      return this.get(jobId);
    }
    throw new HttpException(
      { code: 40905, message: 'export_job_not_pauseable' },
      HttpStatus.CONFLICT,
    );
  }

  async resume(jobId: string): Promise<ExportJob | null> {
    const job = await this.prisma.exportJob.findUnique({ where: { job_id: jobId } });
    if (!job) return null;
    if (job.status !== 'PAUSED') {
      throw new HttpException(
        { code: 40906, message: 'export_job_not_resumable' },
        HttpStatus.CONFLICT,
      );
    }
    await this.cleanupArtifacts(jobId);
    const resumed = await this.prisma.exportJob.updateMany({
      where: { job_id: jobId, status: 'PAUSED' },
      data: {
        status: 'PENDING',
        file_path: null,
        file_name: null,
        total_rows: 0,
        processed_rows: 0,
        groups: 0,
        completed_groups: 0,
        error: null,
        started_at: null,
        finished_at: null,
        expires_at: null,
      },
    });
    if (resumed.count === 0) {
      throw new HttpException(
        { code: 40906, message: 'export_job_not_resumable' },
        HttpStatus.CONFLICT,
      );
    }
    this.schedule(jobId);
    return this.get(jobId);
  }

  async remove(jobId: string): Promise<boolean> {
    const job = await this.prisma.exportJob.findUnique({
      where: { job_id: jobId },
      select: { status: true },
    });
    if (!job) return false;
    if (job.status === 'RUNNING' || job.status === 'PAUSING') {
      throw new HttpException(
        { code: 40907, message: 'pause_export_before_delete' },
        HttpStatus.CONFLICT,
      );
    }
    this.removeFromQueue(jobId);
    const deleted = await this.prisma.exportJob.deleteMany({
      where: {
        job_id: jobId,
        status: { in: ['PENDING', 'PAUSED', 'SUCCESS', 'FAILED'] },
      },
    });
    if (deleted.count === 0) {
      throw new HttpException(
        { code: 40907, message: 'pause_export_before_delete' },
        HttpStatus.CONFLICT,
      );
    }
    await this.cleanupArtifacts(jobId);
    return true;
  }

  private schedule(jobId: string): void {
    if (this.active.has(jobId) || this.queue.includes(jobId)) return;
    this.queue.push(jobId);
    setImmediate(() => {
      void this.drain().catch(() => undefined);
    });
  }

  private removeFromQueue(jobId: string): void {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      if (this.queue[index] === jobId) this.queue.splice(index, 1);
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        const jobId = this.queue.shift();
        if (!jobId) break;
        this.active.add(jobId);
        try {
          await this.run(jobId);
        } finally {
          this.active.delete(jobId);
        }
      }
    } finally {
      this.draining = false;
      if (this.queue.length > 0) setImmediate(() => { void this.drain().catch(() => undefined); });
    }
  }

  private async run(jobId: string): Promise<void> {
    const job = await this.prisma.exportJob.findUnique({ where: { job_id: jobId } });
    if (!job || job.status !== 'PENDING') return;
    const startedAt = new Date();
    const claimed = await this.prisma.exportJob.updateMany({
      where: { job_id: jobId, status: 'PENDING' },
      data: {
        status: 'RUNNING',
        file_path: null,
        file_name: null,
        started_at: startedAt,
        finished_at: null,
        expires_at: null,
        error: null,
        total_rows: 0,
        processed_rows: 0,
        groups: 0,
        completed_groups: 0,
      },
    });
    if (claimed.count === 0) return;
    const filters = job.filters as CustomerListQuery;
    const where = customerWhere(filters);
    const dataDir = process.env.DATA_DIR ?? join(process.cwd(), '.data');
    const exportsDir = join(dataDir, 'exports');
    const attemptId = ulid();
    const workDir = join(exportsDir, `${jobId}.${attemptId}.work`);
    const zipPath = join(exportsDir, `${jobId}.${attemptId}.zip`);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `customers-export-${stamp}.zip`;

    await mkdir(workDir, { recursive: true });
    let output: ReturnType<typeof createWriteStream> | undefined;
    let archive: ReturnType<typeof archiver> | undefined;
    let archiveDone: Promise<void> | undefined;

    try {
      await this.assertRunning(jobId, startedAt);
      const [residentGroups, nonResidentCount] = await Promise.all([
        this.prisma.customer.groupBy({
          by: ['province', 'city'],
          where: { AND: [where, { id_type: 'resident_id' }] },
          _count: { _all: true },
          orderBy: [{ province: 'asc' }, { city: 'asc' }],
        }),
        this.prisma.customer.count({
          where: { AND: [where, { id_type: { not: 'resident_id' } }] },
        }),
      ]);
      const plans = buildExportFilePlans(residentGroups, nonResidentCount);
      const totalRows = plans.reduce((sum, plan) => sum + plan.count, 0);
      await this.prisma.exportJob.updateMany({
        where: { job_id: jobId, status: 'RUNNING', started_at: startedAt },
        data: { total_rows: totalRows, groups: plans.length },
      });
      const outputStream = createWriteStream(zipPath, { flags: 'w', mode: 0o600 });
      const zipArchive = archiver('zip', { zlib: { level: 6 } });
      output = outputStream;
      archive = zipArchive;
      archiveDone = new Promise<void>((resolve, reject) => {
        outputStream.on('close', resolve);
        outputStream.on('error', reject);
        zipArchive.on('error', reject);
      });
      void archiveDone.catch(() => undefined);
      zipArchive.pipe(outputStream);

      let processedRows = 0;
      for (let index = 0; index < plans.length; index += 1) {
        await this.assertRunning(jobId, startedAt);
        const plan = plans[index];
        const xlsxPath = join(workDir, `${String(index).padStart(5, '0')}.xlsx`);
        const fileWhere: Prisma.CustomerWhereInput = plan.kind === 'resident_city'
          ? { AND: [where, { id_type: 'resident_id' }, { province: plan.province }, { city: plan.city }] }
          : { AND: [where, { id_type: { not: 'resident_id' } }] };
        await this.writeWorkbook(jobId, startedAt, xlsxPath, fileWhere, async (fileRows) => {
          await this.prisma.exportJob.updateMany({
            where: { job_id: jobId, status: 'RUNNING', started_at: startedAt },
            data: { processed_rows: processedRows + fileRows },
          });
        });
        await this.assertRunning(jobId, startedAt);
        archive.file(xlsxPath, { name: plan.archiveName });
        processedRows += plan.count;
        await this.prisma.exportJob.updateMany({
          where: { job_id: jobId, status: 'RUNNING', started_at: startedAt },
          data: { processed_rows: processedRows, completed_groups: index + 1 },
        });
      }

      await archive.finalize();
      await archiveDone;
      await this.assertRunning(jobId, startedAt);
      await rm(workDir, { recursive: true, force: true });
      const completed = await this.prisma.exportJob.updateMany({
        where: { job_id: jobId, status: 'RUNNING', started_at: startedAt },
        data: {
          status: 'SUCCESS',
          file_path: zipPath,
          file_name: filename,
          total_rows: totalRows,
          processed_rows: totalRows,
          groups: plans.length,
          completed_groups: plans.length,
          finished_at: new Date(),
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });
      if (completed.count === 0) throw new ExportPauseRequested();
    } catch (error) {
      archive?.abort();
      output?.destroy();
      await rm(workDir, { recursive: true, force: true });
      await rm(zipPath, { force: true });
      if (error instanceof ExportOwnershipLost) return;
      const current = await this.prisma.exportJob.findUnique({
        where: { job_id: jobId },
        select: { status: true, started_at: true },
      });
      if (
        error instanceof ExportPauseRequested
        || (
          current?.started_at?.getTime() === startedAt.getTime()
          && (current.status === 'PAUSING' || current.status === 'PAUSED')
        )
      ) {
        await this.prisma.exportJob.updateMany({
          where: {
            job_id: jobId,
            status: { in: ['RUNNING', 'PAUSING'] },
            started_at: startedAt,
          },
          data: {
            status: 'PAUSED',
            file_path: null,
            file_name: null,
            error: null,
            finished_at: null,
            expires_at: null,
          },
        });
        return;
      }
      await this.prisma.exportJob.updateMany({
        where: { job_id: jobId, status: 'RUNNING', started_at: startedAt },
        data: {
          status: 'FAILED',
          error: error instanceof Error ? error.message : String(error),
          finished_at: new Date(),
        },
      });
    } finally {
      this.pauseRequests.delete(jobId);
    }
  }

  private async assertRunning(jobId: string, startedAt: Date): Promise<void> {
    if (this.pauseRequests.has(jobId)) throw new ExportPauseRequested();
    const job = await this.prisma.exportJob.findUnique({
      where: { job_id: jobId },
      select: { status: true, started_at: true },
    });
    if (job?.started_at?.getTime() !== startedAt.getTime()) throw new ExportOwnershipLost();
    if (job?.status === 'RUNNING') return;
    if (job?.status === 'PAUSING' || job?.status === 'PAUSED') {
      throw new ExportPauseRequested();
    }
    throw new Error('export_job_stopped');
  }

  private async cleanupArtifacts(jobId: string): Promise<void> {
    const dataDir = process.env.DATA_DIR ?? join(process.cwd(), '.data');
    const exportsDir = join(dataDir, 'exports');
    let names: string[];
    try {
      names = await readdir(exportsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    await Promise.all(names
      .filter((name) => name === `${jobId}.work`
        || name === `${jobId}.zip`
        || name.startsWith(`${jobId}.`))
      .map((name) => rm(join(exportsDir, name), { recursive: true, force: true })));
  }

  private async writeWorkbook(
    jobId: string,
    startedAt: Date,
    path: string,
    where: Prisma.CustomerWhereInput,
    onProgress?: (writtenRows: number) => Promise<void>,
  ): Promise<void> {
    const workbookOutput = createWriteStream(path, { flags: 'w', mode: 0o600 });
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: workbookOutput,
      useSharedStrings: false,
      useStyles: false,
    });
    try {
      const sheet = workbook.addWorksheet('customers');
      sheet.columns = EXPORT_COLUMNS.map((column) => ({
        header: column.header,
        key: column.key,
        width: column.width,
      }));
      let cursor: string | undefined;
      let writtenRows = 0;
      let reportedRows = 0;

      for (;;) {
        await this.assertRunning(jobId, startedAt);
        const rows = await this.prisma.customer.findMany({
          where: {
            AND: [
              where,
              ...(cursor ? [{ customer_id: { lt: cursor } }] : []),
            ],
          },
          orderBy: { customer_id: 'desc' },
          take: 1000,
        });
        if (rows.length === 0) break;
        for (const customer of rows) {
          sheet.addRow({
            huji_no: customer.huji_no ?? '',
            name: customer.name,
            id_type: DOCUMENT_TYPES[customer.id_type as DocumentType] ?? customer.id_type,
            id_card: customer.id_card ?? '',
            birth_date: customer.birth_date?.toISOString().slice(0, 10) ?? '',
            gender: customer.gender === 'M' ? '男' : customer.gender === 'F' ? '女' : '未知',
            phone_masked: customer.phone_masked ?? '',
            province: customer.province ?? '',
            city: customer.city ?? '',
            district: customer.district ?? '',
            address: customer.address ?? '',
            occupation: customer.occupation ?? '',
            education: customer.education ?? '',
            marital_status: customer.marital_status ?? '',
            stat_time: customer.stat_time?.toISOString().slice(0, 10) ?? '',
            ingest_batch: customer.ingest_batch ?? '',
          }).commit();
        }
        writtenRows += rows.length;
        if (onProgress && writtenRows - reportedRows >= 10_000) {
          await onProgress(writtenRows);
          reportedRows = writtenRows;
        }
        cursor = rows.at(-1)?.customer_id;
      }

      await sheet.commit();
      await workbook.commit();
      if (onProgress && writtenRows !== reportedRows) await onProgress(writtenRows);
    } catch (error) {
      const workbookArchive = (workbook as unknown as { zip?: { abort(): void } }).zip;
      workbookArchive?.abort();
      workbookOutput.destroy();
      throw error;
    }
  }
}
