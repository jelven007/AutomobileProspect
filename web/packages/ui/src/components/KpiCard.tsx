import { Card, Statistic, type StatisticProps } from 'antd';
import type { ReactNode } from 'react';

export interface KpiCardProps extends StatisticProps {
  extra?: ReactNode;
  loading?: boolean;
  tone?: 'brand' | 'info' | 'warning' | 'success';
}

const TONE_COLOR: Record<NonNullable<KpiCardProps['tone']>, string> = {
  brand: '#1677ff',
  info: '#13c2c2',
  warning: '#faad14',
  success: '#52c41a',
};

export function KpiCard({
  title, value, suffix, prefix, precision, extra, loading, tone = 'brand', valueStyle,
}: KpiCardProps) {
  return (
    <Card bordered={false} loading={loading} extra={extra} style={{ borderRadius: 12 }}>
      <Statistic
        title={title}
        value={value}
        suffix={suffix}
        prefix={prefix}
        precision={precision}
        valueStyle={{ color: TONE_COLOR[tone], ...valueStyle }}
      />
    </Card>
  );
}
