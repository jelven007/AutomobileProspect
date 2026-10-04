import { Controller, Get, Query } from '@nestjs/common';
import type { Lead } from '@leadops/types';

@Controller('sdr')
export class SdrController {
  @Get('leads')
  listLeads(@Query('owner') _owner?: string): Lead[] {
    const now = new Date();
    const in3h = new Date(now.getTime() + 3 * 3600_000).toISOString();
    return [
      {
        lead_id: 'L0001', oneid: 'OID-1001', intent_level: 'L4', intent_score: 0.82,
        preferred_models: ['SUV'], city: '上海',
        assigned_at: now.toISOString(), deadline: in3h,
      },
      {
        lead_id: 'L0002', oneid: 'OID-1002', intent_level: 'L3', intent_score: 0.65,
        preferred_models: ['SEDAN'], city: '北京',
        assigned_at: now.toISOString(), deadline: in3h,
      },
    ];
  }
}
