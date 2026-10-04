import { Layout, List, Avatar, Space, Button, Card } from 'antd';
import { PageContainer, IntentBadge } from '@leadops/ui';
import type { Lead } from '@leadops/types';

const demoLeads: Lead[] = [
  {
    lead_id: 'ld_001',
    oneid: 'O_1000000123',
    intent_level: 'L5',
    intent_score: 86,
    preferred_models: ['ModelX', 'ModelY'],
    city: '上海',
    assigned_at: '2026-10-04T08:30:00Z',
    deadline: '2026-10-05T08:30:00Z',
    recommended_script: '首次外呼_到店邀约_V3',
  },
  {
    lead_id: 'ld_002',
    oneid: 'O_1000000456',
    intent_level: 'L4',
    intent_score: 74,
    preferred_models: ['ModelZ'],
    city: '上海',
    assigned_at: '2026-10-04T09:00:00Z',
    deadline: '2026-10-05T09:00:00Z',
  },
];

export function App() {
  return (
    <Layout style={{ minHeight: '100vh' }}>
      <PageContainer
        title="今日线索池"
        extra={<Button type="primary">刷新</Button>}
      >
        <Card>
          <List
            dataSource={demoLeads}
            renderItem={(lead) => (
              <List.Item
                actions={[
                  <Button key="call" type="link">外呼</Button>,
                  <Button key="followup" type="link">跟进</Button>,
                ]}
              >
                <List.Item.Meta
                  avatar={<Avatar>{lead.city[0]}</Avatar>}
                  title={
                    <Space>
                      <span>{lead.oneid}</span>
                      <IntentBadge level={lead.intent_level} />
                      <span style={{ color: '#999' }}>分数 {lead.intent_score}</span>
                    </Space>
                  }
                  description={`偏好 ${lead.preferred_models.join(' / ')} · ${lead.city}`}
                />
              </List.Item>
            )}
          />
        </Card>
      </PageContainer>
    </Layout>
  );
}
