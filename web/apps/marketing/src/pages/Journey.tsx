import { Card, Empty } from 'antd';
import { PageContainer } from '@leadops/ui';

export function JourneyPage() {
  return (
    <PageContainer title="旅程编排">
      <Card>
        <Empty description="旅程画布占位：接入 React Flow 组件（packages/dag）" />
      </Card>
    </PageContainer>
  );
}
