import { Controller, Get, Param } from '@nestjs/common';
import type { Profile } from '@leadops/types';
import { Roles } from '../common/auth';

@Controller('profile')
@Roles('admin', 'operator', 'viewer')
export class ProfileController {
  @Get(':oneId')
  async getProfile(@Param('oneId') oneId: string): Promise<Profile> {
    return {
      basic: { oneid: oneId, city: '上海' },
      tags: [
        { tag_id: 1, name: '关注SUV', value: 'suv', updated_at: new Date().toISOString() },
        { tag_id: 2, name: '预算20-30万', value: '20-30w', updated_at: new Date().toISOString() },
      ],
      score: { intent_level: 'L4', intent_score: 0.81 },
    };
  }
}
