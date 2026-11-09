import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Alert, Card, Col, Empty, Progress, Row, Select, Skeleton, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { QUALITY_ISSUES, QUALITY_META, type QualityAsset, type QualityReport } from '../../../shared/quality';
import { http } from '../lib/api';
import { usePlants } from '../lib/queries';
import { PageHeader } from '../components/PageHeader';
import { TypeIcon } from '../components/Simple';

export const scoreColor = (score: number) => (score >= 90 ? '#1e9e5a' : score >= 70 ? '#d48806' : '#cf1322');

/** How complete and consistent the documentation is: score, gaps per rule, duplicates and the devices to fix first */
export function DataQualityPage() {
  const navigate = useNavigate();
  const plants = usePlants();
  const [plantId, setPlantId] = useState<string>();
  const q = useQuery({ queryKey: ['data-quality', plantId], queryFn: () => http.get<QualityReport>('/api/data-quality', { plantId, limit: 200 }) });
  const r = q.data;
  const qs = plantId ? `&plantId=${plantId}` : '';

  return (
    <div>
      <PageHeader
        title="Data quality"
        subtitle="How complete the documentation is. Every gap lowers the score of a device; click a rule to see the devices and fix them."
        crumbs={[{ title: 'Administration' }, { title: 'Data quality' }]}
        extra={
          <Select
            allowClear
            placeholder="All plants"
            style={{ width: 240 }}
            value={plantId}
            onChange={setPlantId}
            options={(plants.data ?? []).map((p) => ({ value: p.id, label: `${p.code} – ${p.name}` }))}
          />
        }
      />
      {!r ? (
        <Skeleton active paragraph={{ rows: 10 }} />
      ) : (
        <Space direction="vertical" size={20} style={{ width: '100%' }}>
          <Row gutter={[20, 20]}>
            <Col xs={24} md={8}>
              <Card style={{ height: '100%' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
                  <Progress type="dashboard" percent={r.score} strokeColor={scoreColor(r.score)} format={(p) => `${p}`} size={120} />
                  <div>
                    <div style={{ fontSize: 18, fontWeight: 700 }}>Average score</div>
                    <div className="muted">
                      {r.complete} of {r.total} devices are complete
                    </div>
                  </div>
                </div>
              </Card>
            </Col>
            <Col xs={24} md={16}>
              <Card title="Gaps per rule" style={{ height: '100%' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: '8px 24px' }}>
                  {QUALITY_ISSUES.map((k) => (
                    <Tooltip key={k} title={`${QUALITY_META[k].hint} (−${QUALITY_META[k].weight} points)`}>
                      <Link to={`/inventory?issue=${k}${qs}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, color: r.counts[k] ? undefined : 'var(--cmdb-text-3, #999)' }}>
                        <span>{QUALITY_META[k].label}</span>
                        <Tag color={r.counts[k] ? (k.startsWith('duplicate') ? 'red' : 'orange') : 'default'} style={{ marginInlineEnd: 0 }}>
                          {r.counts[k]}
                        </Tag>
                      </Link>
                    </Tooltip>
                  ))}
                </div>
              </Card>
            </Col>
          </Row>

          {r.duplicates.length > 0 && (
            <Alert
              type="error"
              showIcon
              message={`${r.duplicates.length} possible duplicate${r.duplicates.length > 1 ? 's' : ''}`}
              description={
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {r.duplicates.slice(0, 15).map((d) => (
                    <div key={`${d.kind}-${d.value}`}>
                      <Tag>{d.kind === 'serial' ? 'Serial' : d.kind === 'mac' ? 'MAC' : 'IP'}</Tag>
                      <span className="mono">{d.value}</span>:{' '}
                      {d.assets.map((a, i) => (
                        <span key={a.id}>
                          {i > 0 && ', '}
                          <Link to={`/assets/${a.id}`}>{a.name}</Link>
                          {a.plant_code ? ` (${a.plant_code})` : ''}
                        </span>
                      ))}
                    </div>
                  ))}
                </div>
              }
            />
          )}

          <Card title="Fix these first">
            <Table<QualityAsset>
              rowKey="id"
              dataSource={r.assets}
              pagination={{ pageSize: 25, hideOnSinglePage: true }}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Everything is complete." /> }}
              onRow={(a) => ({ onClick: () => navigate(`/assets/${a.id}`), style: { cursor: 'pointer' } })}
              columns={[
                {
                  title: 'Device',
                  key: 'name',
                  render: (_, a) => (
                    <Space>
                      <TypeIcon type={a.type} />
                      <span>
                        <Typography.Text strong>{a.name}</Typography.Text>
                        {a.plant_code && <span className="muted"> · {a.plant_code}</span>}
                      </span>
                    </Space>
                  ),
                },
                {
                  title: 'Score',
                  key: 'score',
                  width: 160,
                  render: (_, a) => <Progress percent={a.score} size="small" strokeColor={scoreColor(a.score)} format={(p) => `${p}`} />,
                },
                {
                  title: 'Gaps',
                  key: 'issues',
                  render: (_, a) => (
                    <Space size={[4, 4]} wrap>
                      {a.issues.map((i) => (
                        <Tag key={i} color={i.startsWith('duplicate') ? 'red' : undefined}>
                          {QUALITY_META[i].label}
                        </Tag>
                      ))}
                    </Space>
                  ),
                },
              ]}
            />
          </Card>
        </Space>
      )}
    </div>
  );
}
