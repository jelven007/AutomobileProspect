import { Card, Empty } from 'antd';
import { PageContainer } from '@leadops/ui';

export function ExperimentPage() {
  return (
    <PageContainer title="A/B 实验">
      <Card>
        <Empty description="实验列表占位" />
      </Card>
    </PageContainer>
  );
}
