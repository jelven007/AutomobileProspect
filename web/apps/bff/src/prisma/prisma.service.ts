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
    await this.ensureCustomerPartitions();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** 预建上月、当月及未来三个月分区，数据库函数会兼容旧命名分区。 */
  async ensureCustomerPartitions(): Promise<void> {
    try {
      await this.$executeRaw`SELECT ensure_customer_partitions(3)`;
    } catch (e) {
      this.logger.error(`ensure customer partitions failed: ${(e as Error).message}`);
      throw e;
    }
  }
}
