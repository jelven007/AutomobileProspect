import { Typography } from 'antd';
import type { ReactNode } from 'react';

const { Title } = Typography;

export interface PageContainerProps {
  title: string;
  extra?: ReactNode;
  children: ReactNode;
}

export function PageContainer({ title, extra, children }: PageContainerProps) {
  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>{title}</Title>
        {extra}
      </div>
      {children}
    </div>
  );
}
