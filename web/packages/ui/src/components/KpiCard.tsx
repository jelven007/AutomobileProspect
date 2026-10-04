import { Card, Statistic, type StatisticProps } from 'antd';
import type { ReactNode } from 'react';

export interface KpiCardProps extends StatisticProps {
  extra?: ReactNode;
  loading?: boolean;
}

export function KpiCard({ title, value, suffix, prefix, precision, extra, loading }: KpiCardProps) {
  return (
    <Card bordered={false} loading={loading} extra={extra} style={{ borderRadius: 12 }}>
      <Statistic title={title} value={value} suffix={suffix} prefix={prefix} precision={precision} />
    </Card>
  );
}
