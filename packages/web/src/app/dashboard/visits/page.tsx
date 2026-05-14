"use client";

/**
 * 访问统计看板（仅管理员可见 —— 受 middleware 密码门保护）
 *
 * 无登录场景下用 visitorId（浏览器号码牌）+ UA 区分访客。
 * 诚实边界：区分的是「浏览器」非「肉身」；爬虫已按 UA 过滤（可一键纳入）。
 */
import { useEffect, useState } from "react";
import { Card, Table, Statistic, Switch, Button, Typography, Tag, Row, Col, Empty, Skeleton, Space } from "antd";
import { ReloadOutlined, EyeOutlined, TeamOutlined, FireOutlined } from "@ant-design/icons";
import Navbar from "@/components/shared/Navbar";
import BottomNav from "@/components/shared/BottomNav";

const { Title, Text } = Typography;

interface VisitsData {
  overview: { totalPV: number; uniqueVisitors: number; sampleSize: number; includeBots: boolean };
  topPaths: { path: string; count: number }[];
  visitors: {
    visitorId: string;
    short: string;
    count: number;
    browser: string;
    os: string;
    lastSeen: string;
    firstSeen: string;
    referrer: string | null;
  }[];
  recent: {
    id: string;
    visitorShort: string;
    path: string;
    referrer: string | null;
    browser: string;
    os: string;
    createdAt: string;
  }[];
}

function fmt(iso: string): string {
  try {
    return new Date(iso).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return iso;
  }
}

export default function VisitsDashboardPage() {
  const [data, setData] = useState<VisitsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [includeBots, setIncludeBots] = useState(false);

  async function fetchData(bots: boolean) {
    setLoading(true);
    try {
      const r = await fetch(`/api/dashboard/visits?includeBots=${bots ? "1" : "0"}`);
      const json = await r.json();
      if (json.success) setData(json);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchData(includeBots);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeBots]);

  return (
    <div style={{ minHeight: "100vh", background: "#fafafa" }}>
      <Navbar />
      <div style={{ padding: "20px", maxWidth: 1100, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <div>
            <Title level={3} style={{ marginBottom: 4 }}>
              👀 访问统计
            </Title>
            <Text type="secondary" style={{ fontSize: 13 }}>
              无登录用 <code>visitorId</code>（浏览器号码牌）+ UA 区分访客。区分的是「浏览器」非「肉身」，仅你可见。
            </Text>
          </div>
          <Space>
            <Text type="secondary" style={{ fontSize: 12 }}>含爬虫</Text>
            <Switch size="small" checked={includeBots} onChange={setIncludeBots} />
            <Button icon={<ReloadOutlined />} onClick={() => fetchData(includeBots)} loading={loading}>
              刷新
            </Button>
          </Space>
        </div>

        {loading && !data ? (
          <Card style={{ marginTop: 16, borderRadius: 10 }} bordered={false}>
            <Skeleton active paragraph={{ rows: 6 }} />
          </Card>
        ) : (
          <>
            {/* —— 概览 —— */}
            <Row gutter={16} style={{ marginTop: 16 }}>
              <Col xs={12} sm={8}>
                <Card bordered={false} style={{ borderRadius: 10 }}>
                  <Statistic title="总访问 PV" value={data?.overview.totalPV ?? 0} prefix={<EyeOutlined />} />
                </Card>
              </Col>
              <Col xs={12} sm={8}>
                <Card bordered={false} style={{ borderRadius: 10 }}>
                  <Statistic title="独立访客 UV" value={data?.overview.uniqueVisitors ?? 0} prefix={<TeamOutlined />} />
                </Card>
              </Col>
              <Col xs={24} sm={8}>
                <Card bordered={false} style={{ borderRadius: 10 }}>
                  <Statistic title="近期采样" value={data?.overview.sampleSize ?? 0} suffix="条" prefix={<FireOutlined />} />
                </Card>
              </Col>
            </Row>

            {/* —— 访客列表 —— */}
            <Card
              title="访客（按号码牌区分，最近活跃在前）"
              bordered={false}
              style={{ marginTop: 16, borderRadius: 10 }}
            >
              {data && data.visitors.length > 0 ? (
                <Table
                  size="small"
                  rowKey="visitorId"
                  pagination={{ pageSize: 10, hideOnSinglePage: true }}
                  dataSource={data.visitors}
                  columns={[
                    {
                      title: "访客",
                      dataIndex: "short",
                      render: (s: string) => <code style={{ fontSize: 12 }}>{s}</code>,
                    },
                    {
                      title: "设备 / 浏览器",
                      render: (_: any, v: VisitsData["visitors"][0]) => (
                        <Space size={4}>
                          <Tag color="blue">{v.browser}</Tag>
                          <Tag>{v.os}</Tag>
                        </Space>
                      ),
                    },
                    { title: "访问次数", dataIndex: "count", sorter: (a, b) => a.count - b.count, defaultSortOrder: "descend" },
                    {
                      title: "来源",
                      dataIndex: "referrer",
                      render: (r: string | null) =>
                        r ? <Text style={{ fontSize: 12 }} ellipsis={{ tooltip: r }}>{r}</Text> : <Text type="secondary">直接访问</Text>,
                    },
                    { title: "末次访问", dataIndex: "lastSeen", render: (t: string) => <Text style={{ fontSize: 12 }}>{fmt(t)}</Text> },
                  ]}
                />
              ) : (
                <Empty description="暂无访问记录，去别的页面逛两下再回来刷新" />
              )}
            </Card>

            <Row gutter={16} style={{ marginTop: 16 }}>
              {/* —— 热门页面 —— */}
              <Col xs={24} md={10}>
                <Card title="热门页面" bordered={false} style={{ borderRadius: 10, height: "100%" }}>
                  {data && data.topPaths.length > 0 ? (
                    <Table
                      size="small"
                      rowKey="path"
                      pagination={false}
                      dataSource={data.topPaths}
                      columns={[
                        { title: "路径", dataIndex: "path", render: (p: string) => <code style={{ fontSize: 12 }}>{p}</code> },
                        { title: "PV", dataIndex: "count", width: 70, align: "right" as const },
                      ]}
                    />
                  ) : (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无" />
                  )}
                </Card>
              </Col>

              {/* —— 最近访问明细 —— */}
              <Col xs={24} md={14}>
                <Card title="最近访问明细" bordered={false} style={{ borderRadius: 10, height: "100%" }}>
                  {data && data.recent.length > 0 ? (
                    <Table
                      size="small"
                      rowKey="id"
                      pagination={{ pageSize: 8, hideOnSinglePage: true }}
                      dataSource={data.recent}
                      columns={[
                        { title: "访客", dataIndex: "visitorShort", render: (s: string) => <code style={{ fontSize: 11 }}>{s}</code> },
                        { title: "页面", dataIndex: "path", render: (p: string) => <code style={{ fontSize: 11 }}>{p}</code> },
                        {
                          title: "设备",
                          render: (_: any, r: VisitsData["recent"][0]) => (
                            <Text style={{ fontSize: 11 }}>{r.browser}/{r.os}</Text>
                          ),
                        },
                        { title: "时间", dataIndex: "createdAt", render: (t: string) => <Text style={{ fontSize: 11 }}>{fmt(t)}</Text> },
                      ]}
                    />
                  ) : (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无" />
                  )}
                </Card>
              </Col>
            </Row>
          </>
        )}
      </div>
      <BottomNav />
    </div>
  );
}
