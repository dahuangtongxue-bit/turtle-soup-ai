import './globals.css';

export const metadata = {
  title: '海龟汤 · AI 多模型推理',
  description: '六大国产 AI 自动玩海龟汤推理 —— 短视频内容引擎',
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
