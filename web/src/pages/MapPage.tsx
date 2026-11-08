import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Card, Col, Empty, Input, List, Row, Space, Tag, Typography } from 'antd';
import { EnvironmentOutlined, RightOutlined } from '@ant-design/icons';
import { PageHeader } from '../components/PageHeader';
import { WorldMap } from '../components/WorldMap';
import { usePlants } from '../lib/queries';

export function MapPage() {
  const plants = usePlants();
  const [selected, setSelected] = useState<string | undefined>();
  const [filter, setFilter] = useState('');

  const list = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const all = plants.data ?? [];
    if (!q) return all;
    return all.filter((p) => [p.code, p.name, p.city, p.country].some((v) => v?.toLowerCase().includes(q)));
  }, [plants.data, filter]);

  const totalAssets = (plants.data ?? []).reduce((sum, p) => sum + (p.asset_count ?? 0), 0);
  const missingCoords = (plants.data ?? []).filter((p) => p.latitude === null || p.longitude === null).length;

  return (
    <div>
      <PageHeader
        title="Plant map"
        crumbs={[{ title: 'Plants', to: '/plants' }, { title: 'Map' }]}
        subtitle={`${plants.data?.length ?? 0} plants · ${totalAssets} devices${missingCoords ? ` · ${missingCoords} plant(s) without coordinates` : ''}`}
      />
      <Row gutter={16}>
        <Col xs={24} lg={17} style={{ marginBottom: 16 }}>
          <WorldMap plants={plants.data ?? []} height="calc(100vh - 240px)" selectedId={selected} onSelect={setSelected} />
        </Col>
        <Col xs={24} lg={7}>
          <Card
            title={
              <Space>
                <EnvironmentOutlined />
                Plants
              </Space>
            }
            styles={{ body: { padding: 0 } }}
          >
            <div style={{ padding: 12, borderBottom: '1px solid var(--cmdb-border-soft)' }}>
              <Input.Search allowClear placeholder="Filter plants…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
            <div style={{ maxHeight: 'calc(100vh - 300px)', minHeight: 200, overflow: 'auto' }}>
              <List
                loading={plants.isLoading}
                dataSource={list}
                locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No plants" /> }}
                renderItem={(p) => (
                  <List.Item
                    onClick={() => setSelected(p.id)}
                    style={{ cursor: 'pointer', paddingInline: 12, background: p.id === selected ? 'var(--cmdb-primary-soft)' : undefined }}
                    actions={[
                      <Link key="open" to={`/plants/${p.id}`} onClick={(e) => e.stopPropagation()} aria-label={`Open ${p.name}`}>
                        <RightOutlined />
                      </Link>,
                    ]}
                  >
                    <List.Item.Meta
                      avatar={
                        <Tag color="blue" style={{ marginInlineEnd: 0, minWidth: 44, textAlign: 'center' }}>
                          {p.code}
                        </Tag>
                      }
                      title={<span style={{ fontWeight: 500 }}>{p.name}</span>}
                      description={
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {[p.city, p.country].filter(Boolean).join(', ') || '–'} · {p.asset_count ?? 0} assets
                          {(p.latitude === null || p.longitude === null) && <Tag style={{ marginLeft: 6 }}>no coordinates</Tag>}
                        </Typography.Text>
                      }
                    />
                  </List.Item>
                )}
              />
            </div>
          </Card>
        </Col>
      </Row>
    </div>
  );
}
