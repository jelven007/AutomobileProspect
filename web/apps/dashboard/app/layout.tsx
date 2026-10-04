import type { ReactNode } from 'react';

export const metadata = {
  title: '经营大屏 · 潜客运营',
  description: '潜客运营实时经营大屏',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body style={{ margin: 0, background: '#0b1220', color: '#fff', fontFamily: 'PingFang SC, system-ui' }}>
        {children}
      </body>
    </html>
  );
}
