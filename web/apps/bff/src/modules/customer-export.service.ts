import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
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

function serializeJob(job: {
  job_id: string;
  status: string;
  file_name: string | null;
  total_rows: bigint;
  groups: number;
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
    groups: job.groups,
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

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    const interrupted = await this.prisma.exportJob.findMany({
      where: { status: { in: ['PENDING', 'RUNNING'] } },
      select: { job_id: true },
    });
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

  async getDownload(jobId: string): Promise<{ path: string; filename: string } | null> {
    const job = await this.prisma.exportJob.findUnique({ where: { job_id: jobId } });
    if (!job || job.status !== 'SUCCESS' || !job.file_path || !job.file_name) return null;
    if (job.expires_at && job.expires_at < new Date()) return null;
    return { path: job.file_path, filename: job.file_name };
  }

  private schedule(jobId: string): void {
    if (this.active.has(jobId)) return;
    this.active.add(jobId);
    setImmediate(() => {
      void this.run(jobId).finally(() => this.active.delete(jobId));
    });
  }

  private async run(jobId: string): Promise<void> {
    const job = await this.prisma.exportJob.findUnique({ where: { job_id: jobId } });
    if (!job) return;
    const filters = job.filters as CustomerListQuery;
    const where = customerWhere(filters);
    const dataDir = process.env.DATA_DIR ?? join(process.cwd(), '.data');
    const exportsDir = join(dataDir, 'exports');
    const workDir = join(exportsDir, `${jobId}.work`);
    const zipPath = join(exportsDir, `${jobId}.zip`);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `customers-export-${stamp}.zip`;

    await mkdir(workDir, { recursive: true });
    await this.prisma.exportJob.update({
      where: { job_id: jobId },
      data: { status: 'RUNNING', started_at: new Date(), error: null },
    });

    try {
      const groups = await this.prisma.customer.groupBy({
        by: ['province', 'city'],
        where,
        _count: { _all: true },
      });
      const output = createWriteStream(zipPath, { flags: 'w', mode: 0o600 });
      const archive = archiver('zip', { zlib: { level: 6 } });
      const archiveDone = new Promise<void>((resolve, reject) => {
        output.on('close', resolve);
        output.on('error', reject);
        archive.on('error', reject);
      });
      archive.pipe(output);

      let totalRows = 0;
      for (let index = 0; index < groups.length; index += 1) {
        const group = groups[index];
        const province = group.province ?? '未知省份';
        const city = group.city ?? '未知城市';
        const count = group._count._all;
        totalRows += count;
        const safeName = `${province}-${city}-${count}条`.replace(/[\\/:*?"<>|]/g, '_');
        const xlsxPath = join(workDir, `${String(index).padStart(5, '0')}.xlsx`);
        await this.writeGroupWorkbook(
          xlsxPath,
          where,
          group.province,
          group.city,
        );
        archive.file(xlsxPath, { name: `${safeName}.xlsx` });
      }

      await archive.finalize();
      await archiveDone;
      await rm(workDir, { recursive: true, force: true });
      await this.prisma.exportJob.update({
        where: { job_id: jobId },
        data: {
          status: 'SUCCESS',
          file_path: zipPath,
          file_name: filename,
          total_rows: totalRows,
          groups: groups.length,
          finished_at: new Date(),
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });
    } catch (error) {
      await rm(workDir, { recursive: true, force: true });
      await rm(zipPath, { force: true });
      await this.prisma.exportJob.update({
        where: { job_id: jobId },
        data: {
          status: 'FAILED',
          error: error instanceof Error ? error.message : String(error),
          finished_at: new Date(),
        },
      });
    }
  }

  private async writeGroupWorkbook(
    path: string,
    baseWhere: Prisma.CustomerWhereInput,
    province: string | null,
    city: string | null,
  ): Promise<void> {
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      filename: path,
      useSharedStrings: false,
      useStyles: false,
    });
    const sheet = workbook.addWorksheet('customers');
    sheet.columns = EXPORT_COLUMNS.map((column) => ({
      header: column.header,
      key: column.key,
      width: column.width,
    }));
    let cursor: string | undefined;

    for (;;) {
      const rows = await this.prisma.customer.findMany({
        where: {
          AND: [
            baseWhere,
            { province },
            { city },
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
      cursor = rows.at(-1)?.customer_id;
    }

    await sheet.commit();
    await workbook.commit();
  }
}
