"use client";

import { useState, useEffect } from "react";
import { Layout, Card, Button, Checkbox, Progress, Row, Col, Spin, Empty, Badge, Typography, Space, message, Modal, Form, Input, Select, InputNumber, DatePicker, Popconfirm, Tag } from "antd";
import { EditOutlined, DeleteOutlined, DownOutlined, RightOutlined } from "@ant-design/icons";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Task } from "@/types";
import Navbar from "@/components/shared/Navbar";
import BottomNav from "@/components/shared/BottomNav";

const { Title, Text } = Typography;
const { Content } = Layout;
const DEFAULT_USER_ID = "default-user";
const MODULE_OPTIONS = ["React 开发", "Next.js 实战", "TypeScript 进阶", "JavaScript 深入", "算法练习", "前端进阶", "AI 应用开发", "Node.js 后端"];
const DIFFICULTY_OPTIONS = [
  { label: "简单", value: "easy" },
  { label: "中等", value: "medium" },
  { label: "困难", value: "hard" },
];

interface CreateTaskFormValues {
  title: string;
  description?: string;
  module?: string;
  difficulty?: string;
  estimatedMinutes?: number;
  dueDate?: { toDate?: () => Date; toISOString?: () => string } | null;
}

interface TasksPageClientProps {
  /** Server Component SSR 期间预取的初始任务列表 —— 有则首屏无 loading 闪屏 */
  initialTasks?: Task[] | null;
}

export default function TasksPageClient({ initialTasks }: TasksPageClientProps = {}) {
  const [messageApi, contextHolder] = message.useMessage();
  const [editForm] = Form.useForm<CreateTaskFormValues>();
  const [tasks, setTasks] = useState<Task[]>(initialTasks ?? []);
  const [isLoading, setIsLoading] = useState(!initialTasks);
  // isUpdating 复用之前 isCreating 的语义，专用于编辑 Modal 的 confirmLoading
  const [isUpdating, setIsUpdating] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [completingTaskId, setCompletingTaskId] = useState<string | null>(null);
  const [deletingTaskId, setDeletingTaskId] = useState<string | null>(null);
  // 展开/收起：记录哪些 task 当前是展开态，默认全部收起
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  useEffect(() => {
    // SSR 已注水首屏数据则跳过初次 fetch；之后的 create/complete/delete 会触发刷新
    if (!initialTasks) fetchTasks();
  }, [initialTasks]);

  const fetchTasks = async () => {
    try {
      const response = await fetch(`/api/tasks?userId=${DEFAULT_USER_ID}`);
      if (!response.ok) {
        throw new Error("任务列表加载失败");
      }
      const data = await response.json();
      setTasks(data.tasks);
    } catch (error) {
      console.error("Failed to fetch tasks:", error);
      messageApi.error("任务列表加载失败，请稍后重试");
    } finally {
      setIsLoading(false);
    }
  };

  const toggleTaskStatus = async (taskId: string) => {
    try {
      setCompletingTaskId(taskId);

      const response = await fetch(`/api/tasks/${taskId}/complete`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          userId: DEFAULT_USER_ID,
          actualMinutes: 60,
          actualQuestionCount: 20,
          accuracy: 0.75,
          reflection: "页面联调测试：完成后应写入学习记录",
        }),
      });

      if (response.status === 409) {
        messageApi.info("这条任务已经完成，无需重复提交");
        await fetchTasks();
        return;
      }

      if (!response.ok) {
        throw new Error("任务完成失败");
      }

      messageApi.success("任务已完成，并写入学习记录");
      await fetchTasks();
    } catch (error) {
      console.error("Failed to complete task:", error);
      messageApi.error("任务完成失败，请稍后重试");
    } finally {
      setCompletingTaskId(null);
    }
  };

  const deleteTask = async (taskId: string) => {
    try {
      setDeletingTaskId(taskId);
      const response = await fetch(`/api/tasks/${taskId}?userId=${DEFAULT_USER_ID}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("任务删除失败");
      messageApi.success("任务已删除");
      // 同步收掉展开态
      setExpandedIds((prev) => {
        if (!prev.has(taskId)) return prev;
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
      await fetchTasks();
    } catch (error) {
      console.error("Failed to delete task:", error);
      messageApi.error("任务删除失败，请稍后重试");
    } finally {
      setDeletingTaskId(null);
    }
  };

  const updateTask = async (values: CreateTaskFormValues) => {
    if (!editingTask) return;

    try {
      setIsUpdating(true);
      const response = await fetch(`/api/tasks/${editingTask.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          userId: DEFAULT_USER_ID,
          title: values.title.trim(),
          description: values.description?.trim() || "",
          module: values.module,
          difficulty: values.difficulty || "medium",
          estimatedMinutes: values.estimatedMinutes ?? 60,
          dueDate: values.dueDate?.toDate?.().toISOString() || values.dueDate?.toISOString?.() || editingTask.dueDate,
        }),
      });

      if (!response.ok) {
        throw new Error("任务更新失败");
      }

      messageApi.success("任务已更新");
      setIsEditModalOpen(false);
      setEditingTask(null);
      editForm.resetFields();
      await fetchTasks();
    } catch (error) {
      console.error("Failed to update task:", error);
      messageApi.error("任务更新失败，请稍后重试");
    } finally {
      setIsUpdating(false);
    }
  };

  const getStatusColor = (status: Task["status"]) => {
    switch (status) {
      case "todo":
        return "default";
      case "in_progress":
        return "processing";
      case "completed":
        return "success";
      case "overdue":
        return "error";
    }
  };

  const getStatusLabel = (status: Task["status"]) => {
    switch (status) {
      case "todo":
        return "待开始";
      case "in_progress":
        return "进行中";
      case "completed":
        return "已完成";
      case "overdue":
        return "已逾期";
    }
  };

  const todayTasks = tasks.filter((task) => {
    const taskDate = new Date(task.dueDate);
    const today = new Date();
    return (
      taskDate.getDate() === today.getDate() &&
      taskDate.getMonth() === today.getMonth() &&
      taskDate.getFullYear() === today.getFullYear()
    );
  });

  const completedTasks = tasks.filter((task) => task.status === "completed");

  const openEditModal = (task: Task) => {
    setEditingTask(task);
    editForm.setFieldsValue({
      title: task.title,
      description: task.description ?? "",
      module: task.module ?? undefined,
      difficulty: task.difficulty ?? "medium",
      estimatedMinutes: task.estimatedMinutes ?? 60,
      dueDate: task.dueDate ? undefined : undefined,
    });
    setIsEditModalOpen(true);
  };

  if (isLoading) {
    return (
      <Layout style={{ minHeight: "100vh", background: "#fff" }}>
        {contextHolder}
        <Navbar />
        <Content style={{ padding: "16px", paddingBottom: 80 }}>
          <div style={{ maxWidth: 1200, margin: "0 auto" }}>
            <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: 400 }}>
              <Spin size="large" />
            </div>
          </div>
        </Content>
        <BottomNav />
      </Layout>
    );
  }

  return (
    <Layout style={{ minHeight: "100vh", background: "#fff" }}>
      {contextHolder}
      <Navbar />
      <Content style={{ padding: "16px", paddingBottom: 80 }}>
        <div style={{ maxWidth: 1200, margin: "0 auto" }}>
          <Title level={2} style={{ marginBottom: 24 }}>任务管理</Title>

          <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
            <Col xs={24} sm={12}>
              <Card>
                <div style={{ fontSize: 32, fontWeight: "bold", color: "#a78bfa", marginBottom: 8 }}>
                  {todayTasks.length}
                </div>
                <Text type="secondary">今日任务</Text>
              </Card>
            </Col>
            <Col xs={24} sm={12}>
              <Card>
                <div style={{ fontSize: 32, fontWeight: "bold", color: "#10b981", marginBottom: 8 }}>
                  {completedTasks.length}
                </div>
                <Text type="secondary">已完成</Text>
              </Card>
            </Col>
          </Row>

          <Card style={{ marginBottom: 24 }}>
            <Title level={4} style={{ marginBottom: 16 }}>今日任务</Title>
            {todayTasks.length === 0 ? (
              <Empty description="今天没有任务" />
            ) : (
              <Space direction="vertical" size={16} style={{ width: "100%" }}>
                {todayTasks.map((task) => (
                  <Card key={task.id} size="small" style={{ background: "#faf9ff", border: "1px solid #ede9fe" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                          <Checkbox
                            checked={task.status === "completed"}
                            disabled={task.status === "completed" || completingTaskId === task.id}
                            onChange={() => toggleTaskStatus(task.id)}
                          />
                          <Text
                            style={{
                              fontSize: 14,
                              textDecoration: task.status === "completed" ? "line-through" : "none",
                              color: task.status === "completed" ? "#999" : "#000",
                            }}
                          >
                            {task.title}
                          </Text>
                        </div>
                        <div style={{ marginLeft: 32, display: "flex", alignItems: "center", gap: 8 }}>
                          <Badge status={getStatusColor(task.status)} text={getStatusLabel(task.status)} />
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            截止：{task.dueDate}
                          </Text>
                        </div>
                        {task.status === "in_progress" && (
                          <div style={{ marginLeft: 32, marginTop: 12 }}>
                            <Progress
                              percent={task.progress}
                              size="small"
                              strokeColor="#a78bfa"
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  </Card>
                ))}
              </Space>
            )}
          </Card>

          <Card style={{ marginBottom: 24 }}>
            <Title level={4} style={{ marginBottom: 16 }}>
              全部任务 <Text type="secondary" style={{ fontSize: 14, fontWeight: "normal" }}>（共 {tasks.length} 条 · 点击行展开详情）</Text>
            </Title>
            {tasks.length === 0 ? (
              <Empty description="还没有任务，去聊天页让 Agent 帮你制定一份学习计划吧 ✨" />
            ) : (
              <div style={{ border: "1px solid #f0f0f0", borderRadius: 8, overflow: "hidden" }}>
                {tasks.map((task, idx) => {
                  const expanded = expandedIds.has(task.id);
                  const dueDateLabel = task.dueDate
                    ? new Date(task.dueDate).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })
                    : "未设置";
                  return (
                    <div
                      key={task.id}
                      style={{
                        borderBottom: idx === tasks.length - 1 ? "none" : "1px solid #f0f0f0",
                        background: expanded ? "#faf9ff" : "#fff",
                        transition: "background 0.15s ease",
                      }}
                    >
                      {/* 行头部：标题 + 关键信息 + 操作 */}
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 12,
                          padding: "12px 16px",
                          cursor: "pointer",
                        }}
                        onClick={() => toggleExpanded(task.id)}
                      >
                        <span
                          style={{ color: "#9ca3af", display: "flex", alignItems: "center", width: 16 }}
                          aria-label={expanded ? "收起" : "展开"}
                        >
                          {expanded ? <DownOutlined /> : <RightOutlined />}
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <Text
                            strong
                            style={{
                              textDecoration: task.status === "completed" ? "line-through" : "none",
                              color: task.status === "completed" ? "#9ca3af" : "#1f2937",
                              fontSize: 14,
                            }}
                            ellipsis
                          >
                            {task.title}
                          </Text>
                        </div>
                        <Badge status={getStatusColor(task.status)} text={getStatusLabel(task.status)} />
                        <Tag color={task.source === "agent" ? "purple" : "default"} style={{ marginRight: 0 }}>
                          {task.source === "agent" ? "Agent" : "手动"}
                        </Tag>
                        <Text type="secondary" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
                          {dueDateLabel}
                        </Text>
                        <Space size={4} onClick={(e) => e.stopPropagation()}>
                          {task.status !== "completed" && (
                            <Button
                              size="small"
                              type="primary"
                              loading={completingTaskId === task.id}
                              onClick={() => toggleTaskStatus(task.id)}
                            >
                              完成
                            </Button>
                          )}
                          <Button
                            size="small"
                            icon={<EditOutlined />}
                            onClick={() => openEditModal(task)}
                          />
                          <Popconfirm
                            title="确定删除？"
                            description="任务删除后无法恢复"
                            okText="删除"
                            cancelText="取消"
                            okButtonProps={{ danger: true }}
                            onConfirm={() => deleteTask(task.id)}
                          >
                            <Button
                              size="small"
                              danger
                              icon={<DeleteOutlined />}
                              loading={deletingTaskId === task.id}
                            />
                          </Popconfirm>
                        </Space>
                      </div>

                      {/* 展开后的详情区域 */}
                      {expanded && (
                        <div style={{ padding: "0 16px 16px 44px", borderTop: "1px dashed #e5e7eb" }}>
                          <Space size={12} wrap style={{ marginTop: 12 }}>
                            {task.module && <Tag>模块：{task.module}</Tag>}
                            {task.difficulty && <Tag>难度：{task.difficulty}</Tag>}
                            <Tag>预计：{task.estimatedMinutes || 0} 分钟</Tag>
                            <Tag>截止：{task.dueDate ? new Date(task.dueDate).toLocaleString("zh-CN") : "未设置"}</Tag>
                          </Space>
                          {task.progress > 0 && task.status !== "completed" && (
                            <div style={{ marginTop: 12 }}>
                              <Progress percent={task.progress} size="small" strokeColor="#a78bfa" />
                            </div>
                          )}
                          {task.description && (
                            <div
                              className="message-content-wrapper"
                              style={{
                                marginTop: 12,
                                padding: 12,
                                background: "#fff",
                                border: "1px solid #ede9fe",
                                borderRadius: 6,
                                fontSize: 13,
                                lineHeight: 1.7,
                                color: "#374151",
                              }}
                            >
                              <ReactMarkdown
                                remarkPlugins={[remarkGfm]}
                                rehypePlugins={[rehypeHighlight]}
                              >
                                {task.description}
                              </ReactMarkdown>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

        </div>
      </Content>
      <Modal
        title="编辑任务"
        open={isEditModalOpen}
        confirmLoading={isUpdating}
        onCancel={() => {
          if (!isUpdating) {
            setIsEditModalOpen(false);
            setEditingTask(null);
          }
        }}
        onOk={() => editForm.submit()}
        okText="保存修改"
        cancelText="取消"
        destroyOnClose
      >
        <Form<CreateTaskFormValues>
          form={editForm}
          layout="vertical"
          onFinish={updateTask}
        >
          <Form.Item
            label="任务标题"
            name="title"
            rules={[{ required: true, message: "请输入任务标题" }]}
          >
            <Input placeholder="例如：React Hooks 专项练习" maxLength={60} />
          </Form.Item>
          <Form.Item label="任务描述" name="description">
            <Input.TextArea rows={3} maxLength={200} />
          </Form.Item>
          <Form.Item label="模块" name="module">
            <Select
              allowClear
              placeholder="选择对应模块"
              options={MODULE_OPTIONS.map((item) => ({ label: item, value: item }))}
            />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item label="难度" name="difficulty">
                <Select options={DIFFICULTY_OPTIONS} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="预计时长（分钟）" name="estimatedMinutes">
                <InputNumber min={5} max={600} style={{ width: "100%" }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label="截止时间" name="dueDate">
            <DatePicker showTime style={{ width: "100%" }} />
          </Form.Item>
        </Form>
      </Modal>
      <BottomNav />
    </Layout>
  );
}
