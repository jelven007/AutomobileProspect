import type { ThemeConfig } from 'antd';

export const brandTheme: ThemeConfig = {
  token: {
    colorPrimary: '#16a34a',
    colorInfo: '#1677ff',
    colorSuccess: '#16a34a',
    colorWarning: '#f59e0b',
    colorError: '#ef4444',
    borderRadius: 8,
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Helvetica Neue", "PingFang SC", "Microsoft YaHei", Arial, sans-serif',
  },
  components: {
    Layout: {
      headerBg: '#ffffff',
      siderBg: '#001529',
    },
  },
};
