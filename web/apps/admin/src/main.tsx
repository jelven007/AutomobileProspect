import React from 'react';
import ReactDOM from 'react-dom/client';
import { App as AntdApp, ConfigProvider, Layout, Menu } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router-dom';
import { brandTheme } from '@leadops/ui';
import CustomerPage from './pages/Customer';
import IngestJobsPage from './pages/IngestJobs';
import './styles.css';

const { Sider, Content } = Layout;
const qc = new QueryClient();

const menuItems = [
  { key: '/customer', label: <Link to="/customer">客户管理</Link> },
  { key: '/ingest-jobs', label: <Link to="/ingest-jobs">同步任务</Link> },
];

function App() {
  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider theme="dark" width={220}>
        <div style={{ color: '#fff', padding: 16, fontSize: 16 }}>潜客运营 · 管理后台</div>
        <Menu theme="dark" mode="inline" items={menuItems} defaultSelectedKeys={['/customer']} />
      </Sider>
      <Layout>
        <Content>
          <Routes>
            <Route path="/" element={<Navigate to="/customer" replace />} />
            <Route path="/customer" element={<CustomerPage />} />
            <Route path="/ingest-jobs" element={<IngestJobsPage />} />
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
