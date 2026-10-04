import { Layout, Menu } from 'antd';
import { Link, Route, Routes, Navigate } from 'react-router-dom';
import { SegmentPage } from './pages/Segment';
import { JourneyPage } from './pages/Journey';
import { ExperimentPage } from './pages/Experiment';
import { DashboardPage } from './pages/Dashboard';

const { Header, Sider, Content } = Layout;

const menuItems = [
  { key: '/dashboard', label: <Link to="/dashboard">概览</Link> },
  { key: '/segment', label: <Link to="/segment">人群圈选</Link> },
  { key: '/journey', label: <Link to="/journey">旅程编排</Link> },
  { key: '/experiment', label: <Link to="/experiment">A/B 实验</Link> },
];

export function App() {
  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider theme="dark" width={220}>
        <div style={{ color: '#fff', textAlign: 'center', padding: 16, fontSize: 16 }}>
          潜客运营 · 运营工作台
        </div>
        <Menu theme="dark" mode="inline" items={menuItems} defaultSelectedKeys={['/dashboard']} />
      </Sider>
      <Layout>
        <Header style={{ background: '#fff', paddingLeft: 24 }}>欢迎回来</Header>
        <Content>
          <Routes>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/segment" element={<SegmentPage />} />
            <Route path="/journey" element={<JourneyPage />} />
            <Route path="/experiment" element={<ExperimentPage />} />
          </Routes>
        </Content>
      </Layout>
    </Layout>
  );
}
