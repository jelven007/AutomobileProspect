import { Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Nest 风格的 Prisma 客户端包装。
 * - onModuleInit 时建连，启动后给 customer 分区做一次 safety-net 兜底；
 * - onModuleDestroy 时主动断连，避免热更新泄漏连接。
 *
 * 一期 customer 为分区表，RANGE 按 ingest_month；DDL 预建了当年 12 个月分区。
 * 为了避免跨年测试 / 临时数据落空分区报 23514，这里按需补建当月分区。
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    await this.$connect();
    await this.ensureCurrentMonthPartition();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** 确保当月分区存在（跨年或新环境下的兜底）。 */
  async ensureCurrentMonthPartition(): Promise<void> {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth() + 1;
    const nextY = m === 12 ? y + 1 : y;
    const nextM = m === 12 ? 1 : m + 1;
    const from = `${y}-${String(m).padStart(2, '0')}-01`;
    const to = `${nextY}-${String(nextM).padStart(2, '0')}-01`;
    const partName = `customer_p${y}_${String(m).padStart(2, '0')}`;
    try {
      await this.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS ${partName} PARTITION OF customer FOR VALUES FROM ('${from}') TO ('${to}')`,
      );
    } catch (e) {
      // 已有同范围分区（001_init.sql 预建的 customer_pNN）时 CREATE 会撞范围冲突，不致命
      this.logger.warn(`ensure partition ${partName} failed (likely exists): ${(e as Error).message}`);
    }
  }
}
