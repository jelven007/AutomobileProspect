import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { ProfileController } from './modules/profile.controller';
import { SegmentController } from './modules/segment.controller';
import { SdrController } from './modules/sdr.controller';
import { HealthController } from './modules/health.controller';
import { CustomerController, IngestJobController } from './modules/customer.controller';
import { CustomerImportController } from './modules/customer-import.controller';
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
  providers: [CustomerService],
})
export class AppModule {}
