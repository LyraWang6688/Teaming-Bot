import type { Metadata } from 'next';
import { Inspector } from 'react-dev-inspector';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: '组队会议动力分析',
    template: '%s | 组队会议动力分析',
  },
  description:
    '基于 Teaming 与群体动力学框架的会议纪要分析工具，支持飞书事件监听自动分析与报告生成。',
  keywords: [
    '会议分析',
    '团队动力学',
    'Teaming',
    '飞书事件监听',
    '豆包 API',
    'AI 报告',
  ],
  authors: [{ name: '组队会议动力分析项目' }],
  generator: 'Next.js',
  openGraph: {
    title: '组队会议动力分析',
    description:
      '自动接收飞书会议事件，拉取逐字稿，生成团队动力学分析报告。',
    siteName: '组队会议动力分析',
    locale: 'zh_CN',
    type: 'website',
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const isDev = process.env.NODE_ENV === 'development';

  return (
    <html lang="en">
      <body className="antialiased" suppressHydrationWarning>
        {isDev && <Inspector />}
        {children}
      </body>
    </html>
  );
}
