import { Row, Col } from 'antd';
import { KpiCard, PageContainer } from '@leadops/ui';

export function DashboardPage() {
  return (
    <PageContainer title="运营概览">
      <Row gutter={16}>
        <Col span={6}><KpiCard title="今日线索" value={12345} /></Col>
        <Col span={6}><KpiCard title="高意向 (L5)" value={2318} suffix="人" /></Col>
        <Col span={6}><KpiCard title="到店" value={856} /></Col>
        <Col span={6}><KpiCard title="成交" value={102} /></Col>
      </Row>
    </PageContainer>
  );
}
