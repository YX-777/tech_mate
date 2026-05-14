"use client";

import { useEffect, useState } from "react";
import {
  Layout, Card, Button, Input, Typography, Space, Spin, message,
  Empty, Tag, Modal, Tooltip,
} from "antd";
import {
  UserOutlined, EditOutlined, SaveOutlined, CloseOutlined,
  DeleteOutlined, ReloadOutlined,
} from "@ant-design/icons";
import Navbar from "@/components/shared/Navbar";
import BottomNav from "@/components/shared/BottomNav";
import type { UserProfile, LongTermMemoryItem } from "@/types";

const { Title, Text, Paragraph } = Typography;
const { Content } = Layout;
const DEFAULT_USER_ID = "default-user";

interface ProfilePageClientProps {
  /** Server Component SSR 期间预取的初始数据 */
  initialProfile?: UserProfile | null;
  initialMemories?: LongTermMemoryItem[] | null;
}

export default function ProfilePageClient({
  initialProfile,
  initialMemories,
}: ProfilePageClientProps = {}) {
  const [messageApi, contextHolder] = message.useMessage();

  const [profile, setProfile] = useState<UserProfile>(
    initialProfile ?? { nickname: "学习者", totalStudyDays: 0 }
  );
  const [memories, setMemories] = useState<LongTermMemoryItem[]>(initialMemories ?? []);

  const [profileLoading, setProfileLoading] = useState(!initialProfile);
  const [memoryLoading, setMemoryLoading] = useState(!initialMemories);
  const [isSavingNickname, setIsSavingNickname] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editNickname, setEditNickname] = useState(initialProfile?.nickname ?? "");

  useEffect(() => {
    // SSR 注水后跳过初次 CSR fetch；编辑/删除等操作仍会主动调 API 刷新
    if (!initialProfile) void fetchProfile();
    if (!initialMemories) void fetchMemories();
  }, [initialProfile, initialMemories]);

  const fetchProfile = async () => {
    try {
      setProfileLoading(true);
      const r = await fetch(`/api/profile?userId=${DEFAULT_USER_ID}`);
      if (!r.ok) throw new Error("加载个人资料失败");
      const data = await r.json();
      setProfile({
        nickname: data.profile?.nickname || "学习者",
        totalStudyDays: data.profile?.totalStudyDays || 0,
      });
      setEditNickname(data.profile?.nickname || "学习者");
    } catch (e) {
      console.error(e);
      messageApi.error("个人资料加载失败");
    } finally {
      setProfileLoading(false);
    }
  };

  const fetchMemories = async () => {
    try {
      setMemoryLoading(true);
      const r = await fetch(`/api/memory/long-term?userId=${DEFAULT_USER_ID}`);
      if (!r.ok) throw new Error("加载记忆失败");
      const data = await r.json();
      setMemories(data.memories || []);
    } catch (e) {
      console.error(e);
      messageApi.error("个人记忆加载失败");
    } finally {
      setMemoryLoading(false);
    }
  };

  const handleSaveNickname = async () => {
    const trimmed = editNickname.trim();
    if (!trimmed) {
      messageApi.warning("昵称不能为空");
      return;
    }
    try {
      setIsSavingNickname(true);
      const r = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: DEFAULT_USER_ID, nickname: trimmed }),
      });
      if (!r.ok) throw new Error("保存失败");
      const data = await r.json();
      setProfile({
        nickname: data.profile?.nickname || trimmed,
        totalStudyDays: data.profile?.totalStudyDays || 0,
      });
      setIsEditing(false);
      messageApi.success("昵称已更新");
    } catch (e) {
      console.error(e);
      messageApi.error("昵称保存失败");
    } finally {
      setIsSavingNickname(false);
    }
  };

  const handleDeleteMemory = (item: LongTermMemoryItem) => {
    Modal.confirm({
      title: "确认删除这条记忆？",
      content: (
        <div style={{ marginTop: 8 }}>
          <Text type="secondary" style={{ fontSize: 13 }}>
            {item.content.length > 80 ? item.content.slice(0, 80) + "…" : item.content}
          </Text>
        </div>
      ),
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      async onOk() {
        try {
          const r = await fetch(
            `/api/memory/long-term?userId=${DEFAULT_USER_ID}&id=${encodeURIComponent(item.id)}`,
            { method: "DELETE" }
          );
          if (!r.ok) throw new Error("删除失败");
          setMemories((prev) => prev.filter((m) => m.id !== item.id));
          messageApi.success("已删除");
        } catch (e) {
          console.error(e);
          messageApi.error("删除失败，请稍后重试");
        }
      },
    });
  };

  const formatDate = (s: string | null) => {
    if (!s) return "—";
    try {
      return new Date(s).toLocaleDateString("zh-CN", {
        year: "numeric", month: "2-digit", day: "2-digit",
      });
    } catch { return s; }
  };

  const weightColor = (w: number) => {
    if (w >= 0.7) return "#a78bfa";
    if (w >= 0.4) return "#c4b5fd";
    return "#e5e7eb";
  };

  return (
    <Layout style={{ minHeight: "100vh", background: "#fff" }}>
      {contextHolder}
      <Navbar />
      <Content style={{ padding: "24px 16px 80px", background: "#fff" }}>
        <div style={{ maxWidth: 880, margin: "0 auto" }}>

          {/* ===== 个人资料卡（扁平、紫色 accent） ===== */}
          <Card
            bordered={false}
            style={{
              marginBottom: 24,
              background: "#faf9ff",
              border: "1px solid #ede9fe",
              borderRadius: 12,
            }}
            bodyStyle={{ padding: 24 }}
          >
            {profileLoading ? (
              <div style={{ textAlign: "center", padding: 32 }}>
                <Spin />
              </div>
            ) : (
              <Space size={20} align="center" style={{ width: "100%" }}>
                <div style={{
                  width: 64, height: 64, borderRadius: "50%",
                  background: "linear-gradient(135deg, #a78bfa 0%, #8b5cf6 100%)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  color: "#fff", fontSize: 28,
                  flexShrink: 0,
                }}>
                  <UserOutlined />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {isEditing ? (
                    <Space style={{ width: "100%" }}>
                      <Input
                        value={editNickname}
                        onChange={(e) => setEditNickname(e.target.value)}
                        maxLength={20}
                        style={{ width: 200 }}
                        autoFocus
                      />
                      <Button
                        type="primary"
                        size="small"
                        loading={isSavingNickname}
                        icon={<SaveOutlined />}
                        onClick={handleSaveNickname}
                        style={{ background: "#a78bfa", borderColor: "#a78bfa" }}
                      >
                        保存
                      </Button>
                      <Button
                        size="small"
                        icon={<CloseOutlined />}
                        onClick={() => {
                          setEditNickname(profile.nickname);
                          setIsEditing(false);
                        }}
                      >
                        取消
                      </Button>
                    </Space>
                  ) : (
                    <div>
                      <Title level={3} style={{ margin: 0, color: "#1f2937" }}>
                        {profile.nickname}
                        <Tooltip title="编辑昵称">
                          <Button
                            type="text"
                            size="small"
                            icon={<EditOutlined />}
                            onClick={() => setIsEditing(true)}
                            style={{ marginLeft: 8, color: "#a78bfa" }}
                          />
                        </Tooltip>
                      </Title>
                      <Text type="secondary" style={{ fontSize: 13 }}>
                        累计学习 {profile.totalStudyDays} 天
                      </Text>
                      {profile.nickname === "学习者" && (
                        <div style={{ marginTop: 6 }}>
                          <Text type="secondary" style={{ fontSize: 12, color: "#a78bfa" }}>
                            👋 这是默认昵称 —— 点击右侧 ✏️ 修改，或在对话里说「我叫 XXX」自动同步
                          </Text>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </Space>
            )}
          </Card>

          {/* ===== 个人记忆模块 ===== */}
          <Card
            bordered={false}
            style={{
              borderRadius: 12,
              border: "1px solid #f0f0f0",
            }}
            bodyStyle={{ padding: 24 }}
          >
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              marginBottom: 16,
            }}>
              <div>
                <Title level={4} style={{ margin: 0, color: "#1f2937" }}>
                  🧠 个人记忆
                </Title>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  Agent 从对话中提炼并长期保存的内容，按权重排序，可单条删除
                </Text>
              </div>
              <Tooltip title="刷新">
                <Button
                  type="text"
                  icon={<ReloadOutlined />}
                  onClick={fetchMemories}
                  loading={memoryLoading}
                  style={{ color: "#a78bfa" }}
                />
              </Tooltip>
            </div>

            {memoryLoading ? (
              <div style={{ textAlign: "center", padding: 48 }}>
                <Spin />
              </div>
            ) : memories.length === 0 ? (
              <Empty
                description={
                  <Text type="secondary" style={{ fontSize: 13 }}>
                    暂无长期记忆。多和 AI 聊聊，重要的内容会自动沉淀到这里。
                  </Text>
                }
                style={{ padding: "32px 0" }}
              />
            ) : (
              <Space direction="vertical" size={12} style={{ width: "100%" }}>
                {memories.map((m) => (
                  <Card
                    key={m.id}
                    size="small"
                    bordered={false}
                    style={{
                      background: "#faf9ff",
                      border: "1px solid #ede9fe",
                      borderRadius: 8,
                    }}
                    bodyStyle={{ padding: "12px 16px" }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <Paragraph
                          style={{ margin: 0, fontSize: 14, color: "#374151", lineHeight: 1.6 }}
                          ellipsis={{ rows: 3, expandable: true, symbol: "展开" }}
                        >
                          {m.content}
                        </Paragraph>
                        <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                          <Tooltip title="记忆权重（越高越不易遗忘）">
                            <Tag
                              style={{
                                background: weightColor(m.weight),
                                color: m.weight >= 0.4 ? "#fff" : "#6b7280",
                                border: "none",
                                fontSize: 11,
                              }}
                            >
                              权重 {(m.weight * 100).toFixed(0)}%
                            </Tag>
                          </Tooltip>
                          {m.accessCount > 0 && (
                            <Tag style={{ background: "#f3f4f6", color: "#6b7280", border: "none", fontSize: 11 }}>
                              访问 {m.accessCount} 次
                            </Tag>
                          )}
                          {m.topics.slice(0, 4).map((t) => (
                            <Tag key={t} style={{ background: "#f5f3ff", color: "#7c3aed", border: "none", fontSize: 11 }}>
                              {t}
                            </Tag>
                          ))}
                          <Text type="secondary" style={{ fontSize: 11, marginLeft: "auto" }}>
                            {formatDate(m.creationDate)}
                          </Text>
                        </div>
                      </div>
                      <Tooltip title="删除这条记忆">
                        <Button
                          type="text"
                          danger
                          size="small"
                          icon={<DeleteOutlined />}
                          onClick={() => handleDeleteMemory(m)}
                        />
                      </Tooltip>
                    </div>
                  </Card>
                ))}
              </Space>
            )}
          </Card>

        </div>
      </Content>
      <BottomNav />
    </Layout>
  );
}
