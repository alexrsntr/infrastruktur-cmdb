import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { App, Button, Card, Popconfirm, Result, Skeleton, Space, Table, Tag, Typography } from 'antd';
import { ApartmentOutlined, CloudServerOutlined, DatabaseOutlined, DeleteOutlined, EditOutlined, NodeIndexOutlined, PlusOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { DC_LINK_KIND_META, type DatacenterDetail, type DatacenterLink } from '../../../shared/datacenters';
import { ApiError, errorText, http } from '../lib/api';
import { dash } from '../lib/format';
import { useInvalidate } from '../lib/queries';
import { useSession } from '../lib/session';
import { PageHeader } from '../components/PageHeader';
import { StatTile } from '../components/Simple';
import { DatacenterDiagram } from '../components/DatacenterDiagram';
import { DatacenterFormModal, DatacenterLinkModal } from '../components/DatacenterForms';
import { kindLabel } from './DatacentersPage';

export function DatacenterPage() {
  const { datacenterId } = useParams();
  const navigate = useNavigate();
  const { can } = useSession();
  const { message } = App.useApp();
  const invalidate = useInvalidate();
  const [editing, setEditing] = useState(false);
  const [linkModal, setLinkModal] = useState<{ open: boolean; link?: DatacenterLink | null }>({ open: false });
  const q = useQuery({
    queryKey: ['datacenter', datacenterId],
    queryFn: () => http.get<DatacenterDetail>(`/api/datacenters/${datacenterId}`),
    enabled: !!datacenterId,
  });

  if (q.isLoading) return <Skeleton active paragraph={{ rows: 14 }} />;
  if (q.error || !q.data) {
    const status = q.error instanceof ApiError ? q.error.status : 500;
    return (
      <Result
        status={status === 403 ? '403' : status === 404 ? '404' : 'error'}
        title={status === 404 ? 'Data center not found' : status === 403 ? 'No access to this data center' : 'Could not load the data center'}
        subTitle={errorText(q.error)}
        extra={<Button onClick={() => navigate('/datacenters')}>All data centers</Button>}
      />
    );
  }

  const dc = q.data;
  const canEdit = can('location.write');
  const racks = dc.sites.reduce((n, s) => n + s.racks.filter((r) => r.id).length, 0);
  const devices = dc.sites.reduce((n, s) => n + s.racks.reduce((m, r) => m + r.devices.length, 0), 0);
  const stretchedClusters = dc.clusters.filter((c) => c.stretched).length;
  const siteName = (id: string) => dc.sites.find((s) => s.id === id)?.name ?? '–';

  const remove = async () => {
    try {
      await http.del(`/api/datacenters/${dc.id}`);
      message.success(`${dc.name} deleted`);
      await invalidate();
      navigate('/datacenters');
    } catch (e) {
      message.error(errorText(e));
    }
  };
  const removeLink = async (l: DatacenterLink) => {
    try {
      await http.del(`/api/datacenter-links/${l.id}`);
      await invalidate();
    } catch (e) {
      message.error(errorText(e));
    }
  };

  return (
    <div>
      <PageHeader
        crumbs={[
          { title: 'Data centers', to: '/datacenters' },
          { title: `${dc.plant_code} – ${dc.plant_name}`, to: `/plants/${dc.plant_id}` },
        ]}
        icon={
          <span className="page-icon">
            <ApartmentOutlined />
          </span>
        }
        title={dc.name}
        tags={
          <Tag color={dc.kind === 'stretched' ? 'purple' : 'default'} style={{ fontSize: 13, padding: '2px 10px' }}>
            {kindLabel(dc)}
          </Tag>
        }
        subtitle={dc.description ?? undefined}
        extra={
          canEdit && (
            <>
              <Button size="large" icon={<EditOutlined />} onClick={() => setEditing(true)}>
                Edit
              </Button>
              {dc.sites.length > 1 && (
                <Button size="large" icon={<PlusOutlined />} onClick={() => setLinkModal({ open: true })}>
                  Add link
                </Button>
              )}
              <Popconfirm
                title={`Delete ${dc.name}?`}
                description="Only the data center grouping is deleted. Racks and devices stay as they are."
                onConfirm={remove}
                okText="Delete"
                okButtonProps={{ danger: true }}
              >
                <Button size="large" danger icon={<DeleteOutlined />} aria-label="Delete data center" />
              </Popconfirm>
            </>
          )
        }
      />

      <div className="dc-tiles">
        <StatTile icon={<ApartmentOutlined />} value={dc.sites.length} label={dc.sites.length === 1 ? 'Site' : 'Sites'} />
        <StatTile icon={<DatabaseOutlined />} value={racks} label="Racks" color="#5b6b7c" />
        <StatTile icon={<CloudServerOutlined />} value={devices} label="Devices" color="#722ed1" />
        <StatTile icon={<NodeIndexOutlined />} value={dc.links.length} label="Site links" color="#d48806" />
        {stretchedClusters > 0 && <StatTile icon={<ApartmentOutlined />} value={stretchedClusters} label="Stretched clusters" color="#531dab" />}
      </div>

      <Card title="Diagram" style={{ marginBottom: 20 }}>
        <DatacenterDiagram dc={dc} />
      </Card>

      {dc.sites.length > 1 && (
        <Card
          title="Links between the sites"
          extra={
            canEdit && (
              <Button icon={<PlusOutlined />} onClick={() => setLinkModal({ open: true })}>
                Add link
              </Button>
            )
          }
        >
          <Table<DatacenterLink>
            rowKey="id"
            dataSource={dc.links}
            pagination={false}
            scroll={{ x: 760 }}
            locale={{ emptyText: 'No links documented yet – add the fibre trunks or WAN lines that connect the rooms.' }}
            columns={[
              { title: 'Name', dataIndex: 'label', width: 180, render: (v) => <strong>{v}</strong> },
              {
                title: 'Type',
                dataIndex: 'kind',
                width: 170,
                render: (k: DatacenterLink['kind']) => (
                  <Space size={8}>
                    <span style={{ display: 'inline-block', width: 22, height: 6, borderRadius: 3, background: DC_LINK_KIND_META[k].color }} />
                    {DC_LINK_KIND_META[k].label}
                  </Space>
                ),
              },
              { title: 'Between', key: 'sites', width: 200, render: (_, l) => `${siteName(l.site_a_id)} ↔ ${siteName(l.site_b_id)}` },
              { title: 'Capacity / cable', dataIndex: 'capacity', render: (v) => dash(v) },
              { title: 'Length', dataIndex: 'length_m', width: 100, render: (v) => (v != null ? `${v} m` : '–') },
              { title: 'Note', dataIndex: 'note', ellipsis: true, render: (v) => <Typography.Text type="secondary">{dash(v)}</Typography.Text> },
              ...(canEdit
                ? [
                    {
                      title: '',
                      key: 'actions',
                      width: 110,
                      render: (_: unknown, l: DatacenterLink) => (
                        <Space size={4}>
                          <Button type="text" icon={<EditOutlined />} aria-label="Edit link" onClick={() => setLinkModal({ open: true, link: l })} />
                          <Popconfirm title={`Delete ${l.label}?`} onConfirm={() => removeLink(l)} okButtonProps={{ danger: true }}>
                            <Button type="text" danger icon={<DeleteOutlined />} aria-label="Delete link" />
                          </Popconfirm>
                        </Space>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        </Card>
      )}

      <DatacenterFormModal open={editing} datacenter={dc} onClose={() => setEditing(false)} />
      <DatacenterLinkModal open={linkModal.open} link={linkModal.link} datacenter={dc} onClose={() => setLinkModal({ open: false })} />
      <style>{`
        .page-icon { width: 52px; height: 52px; border-radius: 14px; display: grid; place-items: center; font-size: 26px; background: var(--cmdb-primary-soft); color: var(--ant-color-primary, #2563eb); flex: 0 0 auto; }
        .dc-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 14px; margin-bottom: 20px; }
      `}</style>
    </div>
  );
}
