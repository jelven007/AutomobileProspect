import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../common/auth';
import { PrismaService } from '../prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get()
  @Public()
  async check() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { ok: true, service: 'bff', database: 'up', ts: Date.now() };
    } catch {
      throw new ServiceUnavailableException({ code: 50301, message: 'database_unavailable' });
    }
  }
}
