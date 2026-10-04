import { useState } from 'react';
import { Card, Button, Space, Statistic, message } from 'antd';
import { PageContainer } from '@leadops/ui';
import type { SegmentExpr } from '@leadops/types';

const demoExpr: SegmentExpr = {
  op: 'AND',
  children: [
    { tag_id: 1001, op: 'eq', value: 'L5' },
    { tag_id: 1200, op: 'in', value: ['一线'] },
    { tag_id: 3001, op: 'eq', value: true, time_window: '30d' },
  ],
};

export function SegmentPage() {
  const [count, setCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  const handleEstimate = async () => {
    setLoading(true);
    await new Promise((r) => setTimeout(r, 600));
    setCount(1_283_457);
    setLoading(false);
    message.success('预估完成');
  };

  return (
    <PageContainer title="人群圈选">
      <Card title="示例：高意向 · 一线城市 · 近30天留资">
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <pre style={{ background: '#f5f5f5', padding: 12, borderRadius: 8 }}>
            {JSON.stringify(demoExpr, null, 2)}
          </pre>
          <Space>
            <Button type="primary" onClick={handleEstimate} loading={loading}>
              预估人数
            </Button>
            <Button disabled={!count}>保存人群包</Button>
            <Button disabled={!count}>关联旅程</Button>
          </Space>
          {count != null && <Statistic title="预估人数" value={count} />}
        </Space>
      </Card>
    </PageContainer>
  );
}
