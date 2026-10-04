import { Inject, Injectable } from '@nestjs/common';
import { ulid } from 'ulid';
import type { Customer } from '@leadops/types';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** 原始行入参：Pipeline 清洗产出的字段子集 + 可选元信息。 */
export interface IngestRow extends Partial<Customer> {
  name: string;
}

/**
 * Prisma Customer → API Customer（JSON）转换：
 * - DateTime 字段统一输出为 ISO string（保持与 Mock 版兼容）；
 * - birth_date 为 Date 类型，输出 'YYYY-MM-DD'；
 * - undefined 替换 null，避免前端拿到 null 歧义。
 */
export function toCustomer(row: Record<string, unknown>): Customer {
  const birth = row.birth_date as Date | null | undefined;
  const stat = row.stat_time as Date | null | undefined;
  const created = row.created_at as Date | null | undefined;
  const updated = row.updated_at as Date | null | undefined;
  return {
    customer_id: row.customer_id as string,
    huji_no: (row.huji_no as string) ?? '',
    name: row.name as string,
    gender: (row.gender as 'M' | 'F' | 'U' | null) ?? undefined,
    birth_date: birth ? birth.toISOString().slice(0, 10) : undefined,
    id_card: (row.id_card as string | null) ?? undefined,
    phone_masked: (row.phone_masked as string | null) ?? undefined,
    address: (row.address as string | null) ?? undefined,
    stat_time: stat ? stat.toISOString() : undefined,
    province: (row.province as string | null) ?? undefined,
    city: (row.city as string | null) ?? undefined,
    district: (row.district as string | null) ?? undefined,
    occupation: (row.occupation as string | null) ?? undefined,
    education: (row.education as string | null) ?? undefined,
    marital_status: (row.marital_status as string | null) ?? undefined,
    source_file: (row.source_file as string | null) ?? undefined,
    source_row: (row.source_row as number | null) ?? undefined,
    ingest_batch: (row.ingest_batch as string | null) ?? undefined,
    version: (row.version as number) ?? 1,
    is_deleted: (row.is_deleted as boolean) ?? false,
    created_at: created ? created.toISOString() : new Date().toISOString(),
    updated_at: updated ? updated.toISOString() : new Date().toISOString(),
  };
}

/** 推导 ingest_month：从 stat_time（如 '2016-01-01'）或当前 UTC 月取 YYYY-MM-01。 */
export function deriveIngestMonth(statIso?: string | null): Date {
  const base = statIso ? new Date(statIso) : new Date();
  if (Number.isNaN(base.getTime())) {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1));
}

/** 空值 / 空串都算未填，用于 upsert 合并策略（新空值不覆盖旧值）。 */
function hasValue(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  return true;
}

@Injectable()
export class CustomerService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 批量导入入口：匹配优先级 huji_no > id_card > (name + phone_masked)；
   * 命中则 UPSERT（空值不覆盖已有），未命中则新 ULID 插入。
   * 返回 'insert' | 'update' 用于导入报告区分新增/合并数量。
   */
  async upsertFromIngest(row: IngestRow): Promise<'insert' | 'update'> {
    const r = await this.upsertBatch([row]);
    return r.inserted === 1 ? 'insert' : 'update';
  }

  /**
   * 批量 upsert（方案 A+B 优化）：
   *   - A: 把一批行的匹配链合并为单条 OR 查询（1 次 round-trip 拿回全部已存在记录），
   *        而不是每行跑 3 次 SELECT；
   *   - B: 命中组 UPDATE 和未命中组 INSERT 都在一个 `$transaction` 里批量执行，
   *        把 N 次 round-trip 压到 1 次事务。
   *
   * 性能预期：100K 行从单条 upsert 的 486s → 匹配链合并 + 批次事务约 30s。
   *
   * 批内若出现同 huji_no / id_card / name+phone 的"碰撞"（同批两行指向同一个
   * 已存在记录），策略是：按出现顺序先合并第一条，第二条看作 "也命中同一主键"
   * 做二次 UPDATE。这与 keep=last 的语义一致。
   */
  async upsertBatch(rows: IngestRow[]): Promise<{ inserted: number; updated: number }> {
    if (rows.length === 0) return { inserted: 0, updated: 0 };

    // 1) 收集批内所有匹配维度，去空值去重
    //    name+phone 匹配是"兜底第三跳"，只在既无 huji_no 也无 id_card 的行上才用；
    //    否则 1000 行每行都要构造 (name=? AND phone=?) 一组 OR，PG 规划器扛不住。
    const hujiSet = new Set<string>();
    const idCardSet = new Set<string>();
    const namePhoneSet = new Set<string>();
    for (const r of rows) {
      if (r.huji_no) hujiSet.add(r.huji_no);
      if (r.id_card) idCardSet.add(r.id_card);
      if (!r.huji_no && !r.id_card && r.name && r.phone_masked) {
        namePhoneSet.add(`${r.name}\x00${r.phone_masked}`);
      }
    }

    // 2) 一次性 SELECT：OR 匹配三个维度，Prisma 自动用对应索引
    //    huji_no 走 idx_customer_huji，id_card 走 idx_customer_id_card
    //    name+phone 的组合没有专用索引，但在实际数据里空集居多；此处用 OR
    const orConds: Prisma.CustomerWhereInput[] = [];
    if (hujiSet.size > 0) orConds.push({ huji_no: { in: [...hujiSet] } });
    if (idCardSet.size > 0) orConds.push({ id_card: { in: [...idCardSet] } });
    if (namePhoneSet.size > 0) {
      // Prisma 不支持 tuple IN，改成 OR 一组 AND(name, phone_masked)
      const parts = [...namePhoneSet].map((k) => {
        const [name, phone] = k.split('\x00');
        return { name, phone_masked: phone };
      });
      orConds.push({ OR: parts });
    }

    const existingRows = orConds.length === 0
      ? []
      : await this.prisma.customer.findMany({
          where: { is_deleted: false, OR: orConds },
          select: {
            customer_id: true, ingest_month: true, version: true,
            huji_no: true, id_card: true, name: true, phone_masked: true,
          },
        });

    // 3) 建三张 Map 用于 O(1) 匹配
    const byHuji = new Map<string, typeof existingRows[number]>();
    const byIdCard = new Map<string, typeof existingRows[number]>();
    const byNamePhone = new Map<string, typeof existingRows[number]>();
    for (const e of existingRows) {
      if (e.huji_no) byHuji.set(e.huji_no, e);
      if (e.id_card) byIdCard.set(e.id_card, e);
      if (e.name && e.phone_masked) byNamePhone.set(`${e.name}\x00${e.phone_masked}`, e);
    }

    // 4) 分组：命中（需要 UPDATE）vs 未命中（需要 INSERT）
    //    同一批里若两行都命中同一个 existing，按 keep=last 的语义：第二次 UPDATE 覆盖
    //    （对数据库来说仍是两次 UPDATE，复杂度不变）
    type HitRow = { row: IngestRow; target: typeof existingRows[number] };
    const hits: HitRow[] = [];
    const misses: IngestRow[] = [];
    for (const r of rows) {
      const hit = (r.huji_no && byHuji.get(r.huji_no))
        ?? (r.id_card && byIdCard.get(r.id_card))
        ?? (r.name && r.phone_masked && byNamePhone.get(`${r.name}\x00${r.phone_masked}`))
        ?? undefined;
      if (hit) hits.push({ row: r, target: hit });
      else misses.push(r);
    }

    // 5) 构造事务 ops：INSERT 用 createMany（一次 round-trip 插入全部），
    //    UPDATE 一条一条组装（PG 没有单语句批量条件 UPDATE 的 Prisma API，
    //    但放到 $transaction 里是单次网络往返的 pipeline）
    const now = new Date();
    const ops: Prisma.PrismaPromise<unknown>[] = [];

    if (misses.length > 0) {
      const insertData = misses.map((r) => ({
        customer_id: ulid(),
        huji_no: r.huji_no ?? '',
        name: r.name,
        gender: r.gender ?? null,
        birth_date: r.birth_date ? new Date(r.birth_date) : null,
        id_card: r.id_card ?? null,
        phone_masked: r.phone_masked ?? null,
        address: r.address ?? null,
        stat_time: r.stat_time ? new Date(r.stat_time) : null,
        province: r.province ?? null,
        city: r.city ?? null,
        district: r.district ?? null,
        occupation: r.occupation ?? null,
        education: r.education ?? null,
        marital_status: r.marital_status ?? null,
        source_file: r.source_file ?? null,
        source_row: r.source_row ?? null,
        ingest_batch: r.ingest_batch ?? null,
        ingest_month: deriveIngestMonth(r.stat_time),
        version: 1,
        is_deleted: false,
        created_at: now,
        updated_at: now,
      }));
      ops.push(this.prisma.customer.createMany({ data: insertData }));
    }

    for (const { row: r, target } of hits) {
      const data: Prisma.CustomerUpdateInput = {
        version: { increment: 1 },
        updated_at: now,
      };
      if (r.huji_no) data.huji_no = r.huji_no;
      if (r.name) data.name = r.name;
      if (hasValue(r.gender)) data.gender = r.gender;
      if (r.birth_date) data.birth_date = new Date(r.birth_date);
      if (hasValue(r.id_card)) data.id_card = r.id_card;
      if (hasValue(r.phone_masked)) data.phone_masked = r.phone_masked;
      if (hasValue(r.address)) data.address = r.address;
      if (r.stat_time) data.stat_time = new Date(r.stat_time);
      if (hasValue(r.province)) data.province = r.province;
      if (hasValue(r.city)) data.city = r.city;
      if (hasValue(r.district)) data.district = r.district;
      if (hasValue(r.occupation)) data.occupation = r.occupation;
      if (hasValue(r.education)) data.education = r.education;
      if (hasValue(r.marital_status)) data.marital_status = r.marital_status;
      if (hasValue(r.source_file)) data.source_file = r.source_file;
      if (hasValue(r.source_row)) data.source_row = r.source_row;
      if (hasValue(r.ingest_batch)) data.ingest_batch = r.ingest_batch;
      ops.push(
        this.prisma.customer.update({
          where: {
            customer_id_ingest_month: {
              customer_id: target.customer_id,
              ingest_month: target.ingest_month,
            },
          },
          data,
        }),
      );
    }

    if (ops.length > 0) {
      await this.prisma.$transaction(ops);
    }
    return { inserted: misses.length, updated: hits.length };
  }

  getPrisma(): PrismaService {
    return this.prisma;
  }
}
