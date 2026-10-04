import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './common/auth';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { PrismaModule } from './prisma/prisma.module';
import { ProfileController } from './modules/profile.controller';
import { SegmentController } from './modules/segment.controller';
import { SdrController } from './modules/sdr.controller';
import { HealthController } from './modules/health.controller';
import { CustomerController, IngestJobController } from './modules/customer.controller';
import { CustomerImportController } from './modules/customer-import.controller';
import { CustomerExportService } from './modules/customer-export.service';
import { CustomerImportService } from './modules/customer-import.service';
import { CustomerService } from './modules/customer.service';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule],
  controllers: [
    HealthController,
    ProfileController,
    SegmentController,
    SdrController,
    CustomerController,
    CustomerImportController,
    IngestJobController,
  ],
  providers: [
    CustomerService,
    CustomerImportService,
    CustomerExportService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
