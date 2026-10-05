import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { createReadStream } from 'node:fs';
import type { FastifyReply } from 'fastify';
import { ulid } from 'ulid';
import type {
  Customer,
  CustomerListQuery,
  CustomerListResult,
  ExportJob,
  IngestJob,
} from '@leadops/types';
import type { Prisma } from '@prisma/client';
import { documentKey, normalizeDocument, parseIdCard } from '@leadops/ingest-service';
import { type AuthUser, Roles } from '../common/auth';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerExportService } from './customer-export.service';
import { CustomerImportService } from './customer-import.service';
import { deriveIngestMonth, toCustomer } from './customer.service';
import { customerWhere } from './customer-filters';

interface CreateDto extends Partial<Omit<Customer, 'customer_id' | 'version' | 'is_deleted' | 'created_at' | 'updated_at'>> {
  name: string;
}

interface UpdateDto extends Partial<Customer> {
  version: number;
}

interface BatchDeleteDto {
  ids: string[];
}

interface RequestContext {
  user?: AuthUser;
  headers: Record<string, string | string[] | undefined>;
}

function actorOf(request: RequestContext): string {
  return request.user?.sub ?? 'unknown';
}

function requestIdOf(request: RequestContext): string | undefined {
  const value = request.headers['x-request-id'];
  return Array.isArray(value) ? value[0] : value;
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function requireDocument(value: unknown, type?: unknown): { id_card: string; id_type: string } {
  const document = normalizeDocument(value, type);
  if (document.error) {
    throw new HttpException(
      { code: 40001, message: document.error },
      HttpStatus.BAD_REQUEST,
    );
  }
  return { id_card: document.value, id_type: document.type as string };
}

@Controller('customer')
@Roles('admin', 'operator', 'viewer')
export class CustomerController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CustomerExportService) private readonly exports: CustomerExportService,
  ) {}

  @Get()
  async list(
    @Query('q') q?: string,
    @Query('address') address?: string,
    @Query('province') province?: string,
    @Query('city') city?: string,
    @Query('district') district?: string,
    @Query('gender') gender?: 'M' | 'F' | 'U',
    @Query('cursor') cursor?: string,
    @Query('limit') limitValue?: string,
    @Query('id_type') id_type?: string,
    @Query('page') pageValue?: string,
  ): Promise<CustomerListResult> {
    const parsedLimit = Number(limitValue ?? 20);
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(Math.floor(parsedLimit), 1), 200)
      : 20;
    const where = customerWhere({ q, address, province, city, district, gender, id_type });
    if (pageValue !== undefined) {
      const requestedPage = Number(pageValue);
      if (!Number.isSafeInteger(requestedPage) || requestedPage < 1 || cursor) {
        throw new HttpException({ code: 40001, message: 'invalid_page' }, HttpStatus.BAD_REQUEST);
      }
      return this.prisma.$transaction(async (tx) => {
        const total = await tx.customer.count({ where });
        const totalPages = Math.ceil(total / limit);
        const currentPage = Math.min(requestedPage, Math.max(1, totalPages));
        const offset = (currentPage - 1) * limit;
        const take = Math.min(limit, total - offset);
        // Read from the nearer end of the ordered result so the last page is cheap.
        const reverseOffset = total - offset - take;
        const fromEnd = reverseOffset < offset;
        const rows = total === 0 ? [] : await tx.customer.findMany({
          where,
          orderBy: { customer_id: fromEnd ? 'asc' : 'desc' },
          skip: fromEnd ? reverseOffset : offset,
          take,
        });
        if (fromEnd) rows.reverse();
        return {
          items: rows.map((row) => toCustomer(row as unknown as Record<string, unknown>)),
          has_more: currentPage < totalPages,
          next_cursor: currentPage < totalPages ? rows.at(-1)?.customer_id : undefined,
          total, page: currentPage, total_pages: totalPages,
        };
      }, { isolationLevel: 'RepeatableRead', timeout: 60_000 });
    }
    const finalWhere: Prisma.CustomerWhereInput = cursor
      ? { AND: [where, { customer_id: { lt: cursor } }] }
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
    return {
      items: page.map((row) => toCustomer(row as unknown as Record<string, unknown>)),
      next_cursor: hasMore ? page.at(-1)?.customer_id : undefined,
      has_more: hasMore,
      total,
      total_pages: Math.ceil(total / limit),
    };
  }

  @Get('facets')
  async facets(): Promise<{ province: string[]; city: string[]; district: string[] }> {
    const [provinces, cities, districts] = await Promise.all([
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
    const values = (rows: Array<Record<string, unknown>>, key: string) => rows
      .map((row) => row[key])
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .sort((left, right) => left.localeCompare(right, 'zh'));
    return {
      province: values(provinces as never, 'province'),
      city: values(cities as never, 'city'),
      district: values(districts as never, 'district'),
    };
  }

  @Post('exports')
  @Roles('admin', 'operator')
  createExport(
    @Body() query: CustomerListQuery,
    @Req() request: RequestContext,
  ): Promise<ExportJob> {
    const filters = {
      q: query.q,
      address: query.address,
      province: query.province,
      city: query.city,
      district: query.district,
      gender: query.gender,
      id_type: query.id_type,
    };
    return this.exports.create(filters, actorOf(request));
  }

  @Get('exports/:jobId')
  @Roles('admin', 'operator')
  async exportStatus(@Param('jobId') jobId: string): Promise<ExportJob> {
    const job = await this.exports.get(jobId);
    if (!job) {
      throw new HttpException({ code: 40401, message: 'not_found' }, HttpStatus.NOT_FOUND);
    }
    return job;
  }

  @Get('exports')
  @Roles('admin', 'operator')
  listExports(@Query('limit') limitValue?: string): Promise<ExportJob[]> {
    const parsed = Number(limitValue ?? 100);
    const limit = Number.isFinite(parsed) ? Math.floor(parsed) : 100;
    return this.exports.list(limit);
  }

  @Post('exports/:jobId/pause')
  @Roles('admin', 'operator')
  async pauseExport(@Param('jobId') jobId: string): Promise<ExportJob> {
    const job = await this.exports.pause(jobId);
    if (!job) {
      throw new HttpException({ code: 40401, message: 'not_found' }, HttpStatus.NOT_FOUND);
    }
    return job;
  }

  @Post('exports/:jobId/resume')
  @Roles('admin', 'operator')
  async resumeExport(@Param('jobId') jobId: string): Promise<ExportJob> {
    const job = await this.exports.resume(jobId);
    if (!job) {
      throw new HttpException({ code: 40401, message: 'not_found' }, HttpStatus.NOT_FOUND);
    }
    return job;
  }

  @Delete('exports/:jobId')
  @Roles('admin', 'operator')
  async removeExport(@Param('jobId') jobId: string): Promise<{ ok: boolean }> {
    const removed = await this.exports.remove(jobId);
    if (!removed) {
      throw new HttpException({ code: 40401, message: 'not_found' }, HttpStatus.NOT_FOUND);
    }
    return { ok: true };
  }

  @Get('exports/:jobId/download')
  @Roles('admin', 'operator')
  async downloadExport(
    @Param('jobId') jobId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const file = await this.exports.getDownload(jobId);
    if (!file) {
      throw new HttpException(
        { code: 40904, message: 'export_not_ready_or_expired' },
        HttpStatus.CONFLICT,
      );
    }
    reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', `attachment; filename="${file.filename}"`)
      .send(createReadStream(file.path));
  }

  @Get(':id')
  async detail(@Param('id') id: string): Promise<Customer> {
    const customer = await this.prisma.customer.findFirst({
      where: { customer_id: id, is_deleted: false },
    });
    if (!customer) {
      throw new HttpException({ code: 40401, message: 'not_found' }, HttpStatus.NOT_FOUND);
    }
    return toCustomer(customer as unknown as Record<string, unknown>);
  }

  @Post()
  @Roles('admin', 'operator')
  async create(
    @Body() dto: CreateDto,
    @Req() request: RequestContext,
  ): Promise<Customer> {
    if (!dto.name?.trim()) {
      throw new HttpException({ code: 40001, message: 'name_required' }, HttpStatus.BAD_REQUEST);
    }
    const hujiNo = dto.huji_no?.trim() || null;
    if (hujiNo && !/^\d+$/.test(hujiNo)) {
      throw new HttpException({ code: 40001, message: 'huji_no_must_be_digits' }, HttpStatus.BAD_REQUEST);
    }

    const document = requireDocument(dto.id_card, dto.id_type);
    const idCard = document.id_card;
    const info = document.id_type === 'resident_id' ? parseIdCard(idCard) : {};
    const customerId = ulid();
    const ingestMonth = deriveIngestMonth(dto.stat_time);

    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'document:' + documentKey(document)}, 0))`;
      const duplicate = await tx.customerIdentity.findUnique({ where: { id_type_id_card: document } });
      if (duplicate) {
        throw new HttpException({ code: 40901, message: 'id_card_exists' }, HttpStatus.CONFLICT);
      }
      const row = await tx.customer.create({
        data: {
          customer_id: customerId,
          huji_no: hujiNo,
          name: dto.name.trim(),
          gender: dto.gender ?? info.gender ?? null,
          birth_date: dto.birth_date || info.birth_date
            ? new Date((dto.birth_date ?? info.birth_date) as string)
            : null,
          ...document,
          phone_masked: dto.phone_masked ?? null,
          address: dto.address ?? null,
          stat_time: dto.stat_time ? new Date(dto.stat_time) : null,
          province: dto.province?.trim() || info.province
            || (document.id_type === 'resident_id' ? '其他' : null),
          city: dto.city ?? info.city ?? null,
          district: dto.district ?? info.district ?? null,
          occupation: dto.occupation ?? null,
          education: dto.education ?? null,
          marital_status: dto.marital_status ?? null,
          ingest_batch: 'manual',
          ingest_month: ingestMonth,
        },
      });
      await tx.customerIdentity.create({
        data: { ...document, customer_id: customerId, ingest_month: ingestMonth },
      });
      await tx.auditLog.create({
        data: {
          actor: actorOf(request),
          action: 'customer.create',
          entity_type: 'customer',
          entity_id: customerId,
          after_data: jsonValue(row),
          request_id: requestIdOf(request),
        },
      });
      return row;
    });
    return toCustomer(created as unknown as Record<string, unknown>);
  }

  @Put(':id')
  @Roles('admin', 'operator')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateDto,
    @Req() request: RequestContext,
  ): Promise<Customer> {
    if (!Number.isInteger(dto.version) || dto.version < 1) {
      throw new HttpException({ code: 40001, message: 'version_required' }, HttpStatus.BAD_REQUEST);
    }
    // An omitted type preserves the existing namespace when editing a number.
    // Explicit types can be validated without touching the database.
    if (dto.id_card !== undefined && dto.id_type !== undefined) requireDocument(dto.id_card, dto.id_type);
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.customer.findFirst({
        where: { customer_id: id, is_deleted: false },
      });
      if (!existing) {
        throw new HttpException({ code: 40401, message: 'not_found' }, HttpStatus.NOT_FOUND);
      }
      const document = dto.id_card !== undefined || dto.id_type !== undefined
        ? requireDocument(dto.id_card ?? existing.id_card, dto.id_type ?? existing.id_type ?? 'resident_id')
        : { id_card: existing.id_card as string, id_type: existing.id_type ?? 'resident_id' };
      const documentInfo = document.id_type === 'resident_id' ? parseIdCard(document.id_card) : {};
      const data: Prisma.CustomerUncheckedUpdateInput = {
        version: { increment: 1 },
        updated_at: new Date(),
      };
      if (dto.huji_no !== undefined) {
        const hujiNo = dto.huji_no?.trim() || null;
        if (hujiNo && !/^\d+$/.test(hujiNo)) {
          throw new HttpException(
            { code: 40001, message: 'huji_no_must_be_digits' },
            HttpStatus.BAD_REQUEST,
          );
        }
        data.huji_no = hujiNo;
      }
      if (dto.name !== undefined) data.name = dto.name;
      if (dto.gender !== undefined) data.gender = dto.gender;
      if (dto.birth_date !== undefined) data.birth_date = dto.birth_date ? new Date(dto.birth_date) : null;
      if (dto.id_card !== undefined || dto.id_type !== undefined) {
        data.id_card = document.id_card;
        data.id_type = document.id_type;
      }
      if (dto.phone_masked !== undefined) data.phone_masked = dto.phone_masked || null;
      if (dto.address !== undefined) data.address = dto.address || null;
      if (dto.stat_time !== undefined) data.stat_time = dto.stat_time ? new Date(dto.stat_time) : null;
      if (dto.province !== undefined) {
        data.province = dto.province.trim() || documentInfo.province
          || (document.id_type === 'resident_id' ? '其他' : null);
      } else if (
        (dto.id_card !== undefined || dto.id_type !== undefined)
        && document.id_type === 'resident_id'
        && !existing.province
      ) {
        data.province = documentInfo.province ?? '其他';
      }
      if (dto.city !== undefined) data.city = dto.city || null;
      if (dto.district !== undefined) data.district = dto.district || null;
      if (dto.occupation !== undefined) data.occupation = dto.occupation || null;
      if (dto.education !== undefined) data.education = dto.education || null;
      if (dto.marital_status !== undefined) data.marital_status = dto.marital_status || null;

      const idCardChanged = documentKey(document) !== documentKey(existing);
      if (idCardChanged) {
        const lockKeys = [documentKey(existing), documentKey(document)].map((key) => `document:${key}`).sort();
        for (const key of lockKeys) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
        }
        const duplicate = await tx.customerIdentity.findUnique({
          where: { id_type_id_card: document },
        });
        if (duplicate && duplicate.customer_id !== id) {
          throw new HttpException({ code: 40901, message: 'id_card_exists' }, HttpStatus.CONFLICT);
        }
      }

      const changed = await tx.customer.updateMany({
        where: {
          customer_id: id,
          ingest_month: existing.ingest_month,
          version: dto.version,
          is_deleted: false,
        },
        data,
      });
      if (changed.count !== 1) {
        throw new HttpException({ code: 40901, message: 'version_conflict' }, HttpStatus.CONFLICT);
      }
      if (idCardChanged) {
        await tx.customerIdentity.deleteMany({ where: { customer_id: id } });
        await tx.customerIdentity.create({
          data: {
            ...document,
            customer_id: id,
            ingest_month: existing.ingest_month,
          },
        });
      }
      const updated = await tx.customer.findUniqueOrThrow({
        where: {
          customer_id_ingest_month: {
            customer_id: id,
            ingest_month: existing.ingest_month,
          },
        },
      });
      await tx.auditLog.create({
        data: {
          actor: actorOf(request),
          action: 'customer.update',
          entity_type: 'customer',
          entity_id: id,
          before_data: jsonValue(existing),
          after_data: jsonValue(updated),
          request_id: requestIdOf(request),
        },
      });
      return toCustomer(updated as unknown as Record<string, unknown>);
    });
  }

  @Post('batch-delete')
  @Roles('admin')
  async batchDelete(
    @Body() dto: BatchDeleteDto,
    @Req() request: RequestContext,
  ): Promise<{ deleted: number }> {
    if (!Array.isArray(dto?.ids) || dto.ids.length === 0 || dto.ids.length > 5000) {
      throw new HttpException({ code: 40001, message: 'ids_required' }, HttpStatus.BAD_REQUEST);
    }
    return this.softDelete(dto.ids, request, 'customer.batch_delete');
  }

  @Delete('_all')
  @Roles('admin')
  async removeAll(@Req() request: RequestContext): Promise<{ deleted: number }> {
    return this.prisma.$transaction(async (tx) => {
      const changed = await tx.customer.updateMany({
        where: { is_deleted: false },
        data: { is_deleted: true, version: { increment: 1 }, updated_at: new Date() },
      });
      await tx.customerIdentity.deleteMany({});
      await tx.auditLog.create({
        data: {
          actor: actorOf(request),
          action: 'customer.delete_all',
          entity_type: 'customer',
          after_data: jsonValue({ deleted: changed.count }),
          request_id: requestIdOf(request),
        },
      });
      return { deleted: changed.count };
    });
  }

  @Delete(':id')
  @Roles('admin')
  async remove(
    @Param('id') id: string,
    @Req() request: RequestContext,
  ): Promise<{ ok: boolean }> {
    const result = await this.softDelete([id], request, 'customer.delete');
    if (result.deleted === 0) {
      throw new HttpException({ code: 40401, message: 'not_found' }, HttpStatus.NOT_FOUND);
    }
    return { ok: true };
  }

  private async softDelete(
    ids: string[],
    request: RequestContext,
    action: string,
  ): Promise<{ deleted: number }> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.customer.findMany({
        where: { customer_id: { in: ids }, is_deleted: false },
      });
      if (rows.length === 0) return { deleted: 0 };
      const changed = await tx.customer.updateMany({
        where: { customer_id: { in: rows.map((row) => row.customer_id) }, is_deleted: false },
        data: { is_deleted: true, version: { increment: 1 }, updated_at: new Date() },
      });
      await tx.customerIdentity.deleteMany({
        where: { customer_id: { in: rows.map((row) => row.customer_id) } },
      });
      await tx.auditLog.create({
        data: {
          actor: actorOf(request),
          action,
          entity_type: 'customer',
          entity_id: rows.length === 1 ? rows[0].customer_id : undefined,
          before_data: jsonValue(rows),
          after_data: jsonValue({ deleted: changed.count }),
          request_id: requestIdOf(request),
        },
      });
      return { deleted: changed.count };
    });
  }
}

function serializeIngestJob(job: {
  job_id: string;
  source_bucket: string | null;
  source_prefix: string | null;
  file_name: string | null;
  status: string;
  total_rows: bigint;
  success_rows: bigint;
  skipped_rows: bigint;
  duplicate_rows: bigint;
  written_rows: bigint;
  inserted_rows: bigint;
  updated_rows: bigint;
  checkpoint_row: bigint;
  started_at: Date | null;
  finished_at: Date | null;
  error: string | null;
}): IngestJob {
  return {
    job_id: job.job_id,
    source_bucket: job.source_bucket ?? undefined,
    source_prefix: job.source_prefix ?? undefined,
    file_name: job.file_name ?? undefined,
    status: job.status as IngestJob['status'],
    total_rows: Number(job.total_rows),
    success_rows: Number(job.success_rows),
    skipped_rows: Number(job.skipped_rows),
    duplicate_rows: Number(job.duplicate_rows),
    written_rows: Number(job.written_rows),
    inserted_rows: Number(job.inserted_rows),
    updated_rows: Number(job.updated_rows),
    checkpoint_row: Number(job.checkpoint_row),
    started_at: job.started_at?.toISOString(),
    finished_at: job.finished_at?.toISOString(),
    error: job.error ?? undefined,
  };
}

@Controller('ingest-jobs')
@Roles('admin', 'operator', 'viewer')
export class IngestJobController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CustomerImportService) private readonly imports: CustomerImportService,
  ) {}

  @Get()
  async list(): Promise<IngestJob[]> {
    const jobs = await this.prisma.ingestJob.findMany({
      orderBy: { created_at: 'desc' },
      take: 100,
    });
    return jobs.map(serializeIngestJob);
  }

  @Post(':jobId/retry')
  @Roles('admin', 'operator')
  async retry(@Param('jobId') jobId: string): Promise<{ ok: boolean }> {
    await this.imports.retry(jobId);
    return { ok: true };
  }
}
