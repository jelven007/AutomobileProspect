import { Typography } from 'antd';
import type { ReactNode } from 'react';

const { Title } = Typography;

export interface PageContainerProps {
  title: string;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function PageContainer({ title, extra, children, className }: PageContainerProps) {
  return (
    <div className={className} style={{ padding: 16, minWidth: 0, minHeight: 0 }}>
      <div className="page-heading" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <Title level={4} style={{ margin: 0 }}>{title}</Title>
        {extra}
      </div>
      {children}
    </div>
  );
}
