import { Tag } from 'antd';
import type { IntentLevel } from '@leadops/types';

const LEVEL_COLOR: Record<IntentLevel, string> = {
  L5: 'red',
  L4: 'volcano',
  L3: 'orange',
  L2: 'gold',
  L1: 'blue',
  L0: 'default',
};

export function IntentBadge({ level }: { level: IntentLevel }) {
  return <Tag color={LEVEL_COLOR[level]}>{level}</Tag>;
}
