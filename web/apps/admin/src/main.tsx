import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { App as AntdApp, Button, ConfigProvider, Layout, Menu } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ExportOutlined, MenuFoldOutlined, MenuUnfoldOutlined, TeamOutlined, SyncOutlined } from '@ant-design/icons';
import { brandTheme } from '@leadops/ui';
import CustomerPage from './pages/Customer';
import IngestJobsPage from './pages/IngestJobs';
import ExportJobsPage from './pages/ExportJobs';
import './styles.css';

const { Sider, Content } = Layout;
const qc = new QueryClient();

const menuItems = [
  { key: '/customer', icon: <TeamOutlined />, label: <Link to="/customer">客户管理</Link> },
  { key: '/ingest-jobs', icon: <SyncOutlined />, label: <Link to="/ingest-jobs">同步任务</Link> },
  { key: '/export-jobs', icon: <ExportOutlined />, label: <Link to="/export-jobs">导出任务</Link> },
];

function App() {
  const [collapsed, setCollapsed] = useState(false);
  const location = useLocation();
  return (
    <Layout className="app-layout">
      <Sider theme="dark" width={200} collapsedWidth={64} collapsed={collapsed}
        breakpoint="lg" onBreakpoint={setCollapsed}>
        <div className="app-brand" title="潜客运营 · 管理后台">{collapsed ? '潜客' : '潜客运营 · 管理后台'}</div>
        <Menu theme="dark" mode="inline" items={menuItems} selectedKeys={[location.pathname]} />
        <Button className="sidebar-toggle" type="text" aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
          aria-expanded={!collapsed} icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
          onClick={() => setCollapsed((value) => !value)} />
      </Sider>
      <Layout className="app-main">
        <Content className="app-content">
          <Routes>
            <Route path="/" element={<Navigate to="/customer" replace />} />
            <Route path="/customer" element={<CustomerPage />} />
            <Route path="/ingest-jobs" element={<IngestJobsPage />} />
            <Route path="/export-jobs" element={<ExportJobsPage />} />
          </Routes>
        </Content>
      </Layout>
    </Layout>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} theme={brandTheme}>
      <AntdApp>
        <QueryClientProvider client={qc}>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </QueryClientProvider>
      </AntdApp>
    </ConfigProvider>
  </React.StrictMode>,
);
