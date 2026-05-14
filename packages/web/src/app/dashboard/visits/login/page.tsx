"use client";

/**
 * 访问看板登录门（单口令，无用户系统）
 * 输入 .env 里的 ADMIN_KEY，校验通过后种 cookie，跳回访问看板。
 */
import { Suspense, useState } from "react";
import { Card, Input, Button, Typography, message } from "antd";
import { LockOutlined } from "@ant-design/icons";
import { useRouter, useSearchParams } from "next/navigation";

const { Title, Text } = Typography;

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const from = params.get("from") || "/dashboard/visits";
  const [key, setKey] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit() {
    if (!key.trim()) return;
    setLoading(true);
    try {
      const r = await fetch("/api/admin-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      const json = await r.json();
      if (r.ok && json.success) {
        message.success("已解锁");
        router.replace(from);
      } else {
        message.error(json.error || "口令错误");
      }
    } catch {
      message.error("网络错误");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#fafafa" }}>
      <Card bordered={false} style={{ width: 360, borderRadius: 12, boxShadow: "0 4px 24px rgba(0,0,0,0.06)" }}>
        <div style={{ textAlign: "center", marginBottom: 16 }}>
          <LockOutlined style={{ fontSize: 28, color: "#a78bfa" }} />
          <Title level={4} style={{ marginTop: 8, marginBottom: 2 }}>
            访问统计 · 管理员
          </Title>
          <Text type="secondary" style={{ fontSize: 12 }}>
            输入口令查看访问记录（仅你可见）
          </Text>
        </div>
        <Input.Password
          placeholder="ADMIN_KEY"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onPressEnter={submit}
          prefix={<LockOutlined />}
          autoFocus
        />
        <Button type="primary" block style={{ marginTop: 12 }} loading={loading} onClick={submit}>
          解锁
        </Button>
      </Card>
    </div>
  );
}

export default function VisitsLoginPage() {
  // useSearchParams 需要 Suspense 包裹
  return (
    <Suspense fallback={null}>
      <LoginInner />
    </Suspense>
  );
}
