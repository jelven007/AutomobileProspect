import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Res,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { ulid } from 'ulid';
import type { Customer, CustomerListResult, IngestJob } from '@leadops/types';
import type { Prisma } from '@prisma/client';
import { parseIdCard, sanitizeIdCard, expand15To18 } from '@leadops/ingest-service';
import { PrismaService } from '../prisma/prisma.service';
import { toCustomer, deriveIngestMonth } from './customer.service';

interface CreateDto extends Partial<Omit<Customer, 'customer_id' | 'version' | 'is_deleted' | 'created_at' | 'updated_at'>> {
  name: string;
  huji_no?: string;
}
interface UpdateDto extends Partial<Customer> {
  version: number;
}
interface BatchDeleteDto {
  ids: string[];
}

@Controller('customer')
export class CustomerController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get()
  async list(
    @Query('q') q?: string,
    @Query('address') address?: string,
    @Query('province') province?: string,
    @Query('city') city?: string,
    @Query('district') district?: string,
    @Query('gender') gender?: 'M' | 'F' | 'U',
    @Query('cursor') cursor?: string,
    @Query('limit') limitStr?: string,
  ): Promise<CustomerListResult> {
    const limit = Math.min(Math.max(Number(limitStr ?? 20), 1), 200);
    const where: Prisma.CustomerWhereInput = { is_deleted: false };
    if (q) {
      where.OR = [
        { name: { contains: q } },
        { huji_no: { contains: q } },
      ];
    }
    if (address) where.address = { contains: address };
    if (province) where.province = { contains: province };
    if (city) where.city = { contains: city };
    if (district) where.district = { contains: district };
    if (gender) where.gender = gender;

    // cursor 使用 customer_id 字典序倒序，与原 Mock 版本保持一致
    const andCursor: Prisma.CustomerWhereInput[] = [];
    if (cursor) andCursor.push({ customer_id: { lt: cursor } });
    const finalWhere: Prisma.CustomerWhereInput = andCursor.length
      ? { AND: [where, ...andCursor] }
      : where;

    const [rows, total] = await Promise.all([
      this.prisma.customer.findMany({
        where: finalWhere,
        orderBy: { customer_id: 'desc' },
        take: limit + 1,
      }),
      this.prisma.customer.count({ where }),
    ]);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const next = hasMore ? page[page.length - 1]?.customer_id : undefined;
    return {
      items: page.map((r) => toCustomer(r as unknown as Record<string, unknown>)),
      next_cursor: next,
      has_more: hasMore,
      total,
    };
  }

  /** 聚合可选筛选项（province / city / district）供前端下拉。 */
  @Get('facets')
  async facets(): Promise<{ province: string[]; city: string[]; district: string[] }> {
    const [p, c, d] = await Promise.all([
      this.prisma.customer.groupBy({
        by: ['province'],
        where: { is_deleted: false, province: { not: null } },
      }),
      this.prisma.customer.groupBy({
        by: ['city'],
        where: { is_deleted: false, city: { not: null } },
      }),
      this.prisma.customer.groupBy({
        by: ['district'],
        where: { is_deleted: false, district: { not: null } },
      }),
    ]);
    const pick = (rows: Array<Record<string, unknown>>, k: string) =>
      rows
        .map((r) => r[k])
        .filter((v): v is string => typeof v === 'string' && v.length > 0)
        .sort((a, b) => a.localeCompare(b, 'zh'));
    return {
      province: pick(p as never, 'province'),
      city: pick(c as never, 'city'),
      district: pick(d as never, 'district'),
    };
  }

  /**
   * 按筛选条件导出全量数据：按 (province, city) 分组生成多个 xlsx，打包为 zip。
   * 每个 xlsx 文件名：`${province}-${city}-${count}条.xlsx`。
   * 跳过 EnvelopeInterceptor：直接写 Fastify 原生响应。
   */
  @Get('export')
  async export(
    @Res() res: FastifyReply,
    @Query('q') q?: string,
    @Query('address') address?: string,
    @Query('province') province?: string,
    @Query('city') city?: string,
    @Query('district') district?: string,
    @Query('gender') gender?: 'M' | 'F' | 'U',
  ): Promise<void> {
    const where: Prisma.CustomerWhereInput = { is_deleted: false };
    if (q) {
      where.OR = [{ name: { contains: q } }, { huji_no: { contains: q } }];
    }
    if (address) where.address = { contains: address };
    if (province) where.province = { contains: province };
    if (city) where.city = { contains: city };
    if (district) where.district = { contains: district };
    if (gender) where.gender = gender;

    const items = await this.prisma.customer.findMany({
      where,
      orderBy: { customer_id: 'desc' },
    });
    const asCustomer = items.map((r) => toCustomer(r as unknown as Record<string, unknown>));

    const groups = new Map<string, { province: string; city: string; rows: Customer[] }>();
    for (const r of asCustomer) {
      const p = r.province || '未知省份';
      const c = r.city || '未知城市';
      const key = `${p}__${c}`;
      let g = groups.get(key);
      if (!g) {
        g = { province: p, city: c, rows: [] };
        groups.set(key, g);
      }
      g.rows.push(r);
    }

    const zip = new JSZip();
    for (const { province: p, city: c, rows } of groups.values()) {
      const buf = await buildCustomerXlsx(rows);
      const safeName = `${p}-${c}-${rows.length}条`.replace(/[\\/:*?"<>|]/g, '_');
      zip.file(`${safeName}.xlsx`, buf);
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const zipBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

    res
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', `attachment; filename="customers-export-${stamp}.zip"`)
      .header('X-Export-Groups', String(groups.size))
      .header('X-Export-Total', String(asCustomer.length))
      .send(zipBuf);
  }

  @Get(':id')
  async detail(@Param('id') id: string): Promise<Customer> {
    const c = await this.prisma.customer.findFirst({
      where: { customer_id: id, is_deleted: false },
    });
    if (!c) throw new HttpException({ code: 40401, message: 'not_found' }, HttpStatus.NOT_FOUND);
    return toCustomer(c as unknown as Record<string, unknown>);
  }

  @Post()
  async create(@Body() dto: CreateDto): Promise<Customer> {
    if (!dto.name) {
      throw new HttpException({ code: 40001, message: 'name required' }, HttpStatus.BAD_REQUEST);
    }
    if (dto.huji_no && !/^\d+$/.test(dto.huji_no)) {
      throw new HttpException({ code: 40001, message: 'huji_no must be digits' }, HttpStatus.BAD_REQUEST);
    }
    if (dto.huji_no) {
      const dup = await this.prisma.customer.findFirst({
        where: { huji_no: dto.huji_no, is_deleted: false },
      });
      if (dup) {
        throw new HttpException({ code: 40901, message: 'huji_no exists' }, HttpStatus.CONFLICT);
      }
    }

    const clean = sanitizeIdCard(dto.id_card ?? '');
    const rawIdCard = clean.length === 15 ? (expand15To18(clean) ?? clean) : clean;
    const info = /^\d{17}[\dX]$/.test(rawIdCard) ? parseIdCard(rawIdCard) : {};

    const id = ulid();
    const birth = (dto.birth_date ?? info.birth_date)
      ? new Date((dto.birth_date ?? info.birth_date) as string)
      : null;
    const stat = dto.stat_time ? new Date(dto.stat_time) : null;
    const ingestMonth = deriveIngestMonth(dto.stat_time);
    const created = await this.prisma.customer.create({
      data: {
        customer_id: id,
        huji_no: dto.huji_no ?? '',
        name: dto.name,
        gender: dto.gender ?? info.gender ?? null,
        birth_date: birth,
        id_card: rawIdCard || null,
        phone_masked: dto.phone_masked ?? null,
        address: dto.address ?? null,
        stat_time: stat,
        province: dto.province ?? info.province ?? null,
        city: dto.city ?? info.city ?? null,
        district: dto.district ?? info.district ?? null,
        occupation: dto.occupation ?? null,
        education: dto.education ?? null,
        marital_status: dto.marital_status ?? null,
        source_file: null,
        source_row: null,
        ingest_batch: 'manual',
        ingest_month: ingestMonth,
        version: 1,
        is_deleted: false,
      },
    });
    return toCustomer(created as unknown as Record<string, unknown>);
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateDto): Promise<Customer> {
    const c = await this.prisma.customer.findFirst({
      where: { customer_id: id, is_deleted: false },
    });
    if (!c) throw new HttpException({ code: 40401, message: 'not_found' }, HttpStatus.NOT_FOUND);
    if (dto.version !== c.version) {
      throw new HttpException({ code: 40901, message: 'version_conflict' }, HttpStatus.CONFLICT);
    }
    const data: Prisma.CustomerUpdateInput = {
      version: c.version + 1,
      updated_at: new Date(),
    };
    if (dto.huji_no !== undefined) data.huji_no = dto.huji_no;
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.gender !== undefined) data.gender = dto.gender;
    if (dto.birth_date !== undefined) data.birth_date = dto.birth_date ? new Date(dto.birth_date) : null;
    if (dto.id_card !== undefined) data.id_card = dto.id_card ?? null;
    if (dto.phone_masked !== undefined) data.phone_masked = dto.phone_masked ?? null;
    if (dto.address !== undefined) data.address = dto.address ?? null;
    if (dto.stat_time !== undefined) data.stat_time = dto.stat_time ? new Date(dto.stat_time) : null;
    if (dto.province !== undefined) data.province = dto.province ?? null;
    if (dto.city !== undefined) data.city = dto.city ?? null;
    if (dto.district !== undefined) data.district = dto.district ?? null;
    if (dto.occupation !== undefined) data.occupation = dto.occupation ?? null;
    if (dto.education !== undefined) data.education = dto.education ?? null;
    if (dto.marital_status !== undefined) data.marital_status = dto.marital_status ?? null;

    const updated = await this.prisma.customer.update({
      where: {
        customer_id_ingest_month: {
          customer_id: c.customer_id,
          ingest_month: c.ingest_month,
        },
      },
      data,
    });
    return toCustomer(updated as unknown as Record<string, unknown>);
  }

  /** 批量删除（硬删除，一期简化）。 */
  @Post('batch-delete')
  async batchDelete(@Body() dto: BatchDeleteDto): Promise<{ deleted: number }> {
    if (!Array.isArray(dto?.ids) || dto.ids.length === 0) {
      throw new HttpException({ code: 40001, message: 'ids required' }, HttpStatus.BAD_REQUEST);
    }
    const r = await this.prisma.customer.deleteMany({
      where: { customer_id: { in: dto.ids } },
    });
    return { deleted: r.count };
  }

  /** 清空全部数据（含已软删除），一期便捷开关。 */
  @Delete('_all')
  async removeAll(): Promise<{ deleted: number }> {
    const r = await this.prisma.customer.deleteMany({});
    return { deleted: r.count };
  }

  @Delete(':id')
  async remove(@Param('id') id: string): Promise<{ ok: boolean }> {
    const r = await this.prisma.customer.deleteMany({ where: { customer_id: id } });
    if (r.count === 0) {
      throw new HttpException({ code: 40401, message: 'not_found' }, HttpStatus.NOT_FOUND);
    }
    return { ok: true };
  }
}

@Controller('ingest-jobs')
export class IngestJobController {
  private jobs: IngestJob[] = [];

  @Get()
  list(): IngestJob[] {
    return this.jobs;
  }

  @Post(':jobId/retry')
  retry(@Param('jobId') jobId: string) {
    const j = this.jobs.find((x) => x.job_id === jobId);
    if (!j) throw new HttpException({ code: 40401, message: 'not_found' }, HttpStatus.NOT_FOUND);
    j.status = 'PENDING';
    j.started_at = undefined;
    j.finished_at = undefined;
    return { ok: true };
  }
}

const EXPORT_COLUMNS: Array<{ header: string; key: keyof Customer; width: number }> = [
  { header: '编码编号', key: 'huji_no', width: 18 },
  { header: '姓名', key: 'name', width: 10 },
  { header: '身份证', key: 'id_card', width: 20 },
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

async function buildCustomerXlsx(rows: Customer[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('customers');
  ws.columns = EXPORT_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  ws.getRow(1).font = { bold: true };
  for (const r of rows) {
    const row: Record<string, unknown> = {};
    for (const c of EXPORT_COLUMNS) {
      const v = r[c.key];
      if (c.key === 'gender') {
        row[c.key] = v === 'M' ? '男' : v === 'F' ? '女' : v ? '未知' : '';
      } else if (c.key === 'stat_time') {
        // stat_time 后端存 TIMESTAMPTZ，导出统一按 YYYY-MM-DD 展示（与出生日期一致）
        row[c.key] = v ? String(v).slice(0, 10) : '';
      } else {
        row[c.key] = v ?? '';
      }
    }
    ws.addRow(row);
  }
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
