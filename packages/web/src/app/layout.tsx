"use client";

import { ConfigProvider, App as AntdApp } from "antd";
import zhCN from "antd/locale/zh_CN";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import { antdTheme } from "@/config/theme";
import PageviewTracker from "@/components/PageviewTracker";
import "../styles/globals.css";

// AntdRegistry：把 antd v6 的 CSS-in-JS 样式收集到 SSR HTML head，
// 避免刷新/初次 loading 时 antd 组件（Title/Input/Button 等）出现一闪而过的无样式状态（FOUC）。
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>
        <AntdRegistry>
          <ConfigProvider theme={antdTheme} locale={zhCN}>
            <AntdApp>
              <PageviewTracker />
              {children}
            </AntdApp>
          </ConfigProvider>
        </AntdRegistry>
      </body>
    </html>
  );
}