import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button, Card, Col, Empty, Row, Select, Skeleton, Tag, Typography } from 'antd';
import { ApartmentOutlined, PlusOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { DC_SITE_ROLE_META, type DatacenterSummary } from '../../../shared/datacenters';
import { http } from '../lib/api';
import { usePlants } from '../lib/queries';
import { useSession } from '../lib/session';
import { PageHeader } from '../components/PageHeader';
import { ExportMenu } from '../components/ExportMenu';
import { DatacenterFormModal } from '../components/DatacenterForms';

export function useDatacenters(plantId?: string) {
  return useQuery({ queryKey: ['datacenters', plantId ?? 'all'], queryFn: () => http.get<DatacenterSummary[]>('/api/datacenters', { plantId }) });
}

export function kindLabel(dc: Pick<DatacenterSummary, 'kind' | 'sites'>) {
  if (dc.kind === 'single') return 'One room';
  const buildings = new Set(dc.sites.filter((s) => s.role !== 'witness').map((s) => s.building_id)).size;
  return `Stretched across ${buildings} building${buildings === 1 ? '' : 's'}`;
}

export function DatacentersPage() {
  const { can, me } = useSession();
  const navigate = useNavigate();
  const plants = usePlants();
  const [plantId, setPlantId] = useState<string | undefined>();
  const list = useDatacenters(plantId);
  const [creating, setCreating] = useState(false);
  const singlePlant = me.user.plantScope.length === 1;

  return (
    <div>
      <PageHeader
        icon={
          <span className="page-icon">
            <ApartmentOutlined />
          </span>
        }
        title="Data centers"
        subtitle="Server rooms of each plant – also when one data center is split across two buildings."
        extra={
          <>
            <ExportMenu dataset="datacenters" query={{ plantId }} />
            {can('location.write') && (
              <Button type="primary" size="large" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
                New data center
              </Button>
            )}
          </>
        }
      />

      {!singlePlant && (plants.data?.length ?? 0) > 1 && (
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder="All plants"
          size="large"
          style={{ width: 280, marginBottom: 20 }}
          value={plantId}
          onChange={setPlantId}
          options={(plants.data ?? []).map((p) => ({ value: p.id, label: `${p.code} – ${p.name}` }))}
        />
      )}

      {list.isLoading ? (
        <Skeleton active paragraph={{ rows: 6 }} />
      ) : !list.data?.length ? (
        <Card>
          <Empty
            image={<ApartmentOutlined style={{ fontSize: 56, color: '#9aa7b4' }} />}
            description={
              <div style={{ maxWidth: 560, margin: '0 auto' }}>
                <Typography.Title level={4} style={{ marginTop: 8 }}>
                  No data center documented yet
                </Typography.Title>
                <Typography.Paragraph type="secondary" style={{ fontSize: 15 }}>
                  A data center groups your server rooms. If it is <strong>stretched</strong> across two buildings – for example a cluster with hosts in both rooms – the CMDB draws both rooms side by side with
                  their racks, the fibre links between them and the connections of the core switches.
                </Typography.Paragraph>
              </div>
            }
          >
            {can('location.write') && (
              <Button type="primary" size="large" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
                Create the first data center
              </Button>
            )}
          </Empty>
        </Card>
      ) : (
        <Row gutter={[20, 20]}>
          {list.data.map((dc) => {
            const racks = dc.sites.reduce((n, s) => n + Number(s.rack_count), 0);
            const devices = dc.sites.reduce((n, s) => n + Number(s.device_count), 0);
            return (
              <Col key={dc.id} xs={24} lg={12} xxl={8}>
                <Link to={`/datacenters/${dc.id}`} style={{ color: 'inherit' }}>
                  <Card hoverable style={{ height: '100%' }} styles={{ body: { display: 'flex', flexDirection: 'column', gap: 14 } }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
                      <div style={{ minWidth: 0 }}>
                        <Typography.Title level={4} style={{ margin: 0 }}>
                          {dc.name}
                        </Typography.Title>
                        <Typography.Text type="secondary">
                          {dc.plant_code} – {dc.plant_name}
                        </Typography.Text>
                      </div>
                      <Tag color={dc.kind === 'stretched' ? 'purple' : 'default'} style={{ marginInlineEnd: 0, fontSize: 13, padding: '2px 10px' }}>
                        {kindLabel(dc)}
                      </Tag>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {dc.sites.map((s) => (
                        <div key={s.id} className="dc-card-site">
                          <Tag color={DC_SITE_ROLE_META[s.role].color} style={{ marginInlineEnd: 0, minWidth: 82, textAlign: 'center' }}>
                            {s.name}
                          </Tag>
                          <span style={{ fontWeight: 600 }}>
                            {s.building_code} – {s.building_name}
                          </span>
                          {s.room && <span className="muted">· {s.room}</span>}
                          <span className="muted" style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>
                            {s.rack_count} racks
                          </span>
                        </div>
                      ))}
                    </div>
                    <div className="dc-card-counts">
                      <span>
                        <strong>{racks}</strong> racks
                      </span>
                      <span>
                        <strong>{devices}</strong> devices
                      </span>
                      <span>
                        <strong>{dc.link_count}</strong> site links
                      </span>
                    </div>
                  </Card>
                </Link>
              </Col>
            );
          })}
        </Row>
      )}

      <DatacenterFormModal open={creating} onClose={() => setCreating(false)} defaultPlantId={plantId} onSaved={(dc) => navigate(`/datacenters/${dc.id}`)} />
      <style>{`
        .page-icon { width: 52px; height: 52px; border-radius: 14px; display: grid; place-items: center; font-size: 26px; background: #e8effd; color: var(--ant-color-primary, #2563eb); flex: 0 0 auto; }
        .dc-card-site { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 15px; padding: 8px 10px; background: #f6f8fa; border-radius: 8px; }
        .dc-card-counts { display: flex; gap: 22px; flex-wrap: wrap; font-size: 14.5px; color: #4a5a6c; border-top: 1px solid #edf0f3; padding-top: 12px; }
        .dc-card-counts strong { color: #14202e; font-size: 17px; }
      `}</style>
    </div>
  );
}
