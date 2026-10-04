import { Body, Controller, Get, Post } from '@nestjs/common';
import type { Segment, SegmentExpr } from '@leadops/types';
import { Roles } from '../common/auth';

interface EstimateDto {
  expr: SegmentExpr;
}

@Controller('segment')
@Roles('admin', 'operator', 'viewer')
export class SegmentController {
  @Get()
  list(): Segment[] {
    const now = new Date().toISOString();
    return [
      {
        segment_id: 'seg_001', name: '北京高意向 SUV', owner: 'demo',
        expression: { op: 'AND', children: [] },
        status: 'ready', estimated_count: 23421, created_at: now,
      },
      {
        segment_id: 'seg_002', name: '新能源观望', owner: 'demo',
        expression: { op: 'AND', children: [] },
        status: 'ready', estimated_count: 158200, created_at: now,
      },
    ];
  }

  @Post('estimate')
  @Roles('admin', 'operator')
  estimate(@Body() dto: EstimateDto) {
    const sample = JSON.stringify(dto.expr).length;
    return { estimated_count: sample * 1234, cost: '< 300ms' };
  }
}
