import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Alert, App, Button, Card, Col, Drawer, Empty, Form, Input, InputNumber, Modal, Popconfirm, Progress, Row, Select, Skeleton, Space, Table, Tag, Typography } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import type { PlantNetwork, Subnet, SubnetDetail, Vlan } from '../../../shared/network';
import { errorText, http } from '../lib/api';
import { useInvalidate } from '../lib/queries';
import { useSession } from '../lib/session';
import { StatusDot, TypeIcon } from './Simple';
import { SectionHead } from './PageParts';

export const usePlantNetwork = (plantId: string) =>
  useQuery({ queryKey: ['network', plantId], queryFn: () => http.get<PlantNetwork>(`/api/plants/${plantId}/network`) });

function Usage({ s }: { s: Subnet }) {
  if (!s.size) return <span className="muted">{s.used} used</span>;
  const pct = Math.round((s.used / s.size) * 100);
  return (
    <div style={{ minWidth: 150 }}>
      <Progress percent={pct} size="small" status={pct >= 90 ? 'exception' : 'normal'} showInfo={false} />
      <span className="muted" style={{ fontSize: 12.5 }}>
        {s.used} of {s.size} used · {s.size - s.used} free
      </span>
    </div>
  );
}

/** VLANs, IP subnets with used/free addresses and duplicate IPs of one plant */
export function NetworkTab({ plantId }: { plantId: string }) {
  const { can } = useSession();
  const { message } = App.useApp();
  const invalidate = useInvalidate();
  const net = usePlantNetwork(plantId);
  const [subnetModal, setSubnetModal] = useState<{ open: boolean; subnet?: Subnet }>({ open: false });
  const [vlanModal, setVlanModal] = useState<{ open: boolean; vlan?: Vlan }>({ open: false });
  const [detail, setDetail] = useState<string | null>(null);
  const writable = can('asset.write');

  if (net.isLoading || !net.data) return <Skeleton active paragraph={{ rows: 8 }} />;
  const { vlans, subnets, duplicates, unassigned, connections } = net.data;

  const removeVlan = async (v: Vlan) => {
    try {
      await http.del(`/api/vlans/${v.id}`);
      message.success(`VLAN ${v.vid} deleted`);
      await invalidate();
    } catch (e) {
      message.error(errorText(e));
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {duplicates.length > 0 && (
        <Alert
          type="error"
          showIcon
          message={`${duplicates.length} IP address${duplicates.length > 1 ? 'es are' : ' is'} documented on more than one device`}
          description={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {duplicates.slice(0, 10).map((d) => (
                <div key={d.ip}>
                  <span className="mono" style={{ fontWeight: 600 }}>
                    {d.ip}
                  </span>
                  {': '}
                  {d.assets.map((a, i) => (
                    <span key={a.id}>
                      {i > 0 && ', '}
                      <Link to={`/assets/${a.id}`}>{a.name}</Link>
                    </span>
                  ))}
                </div>
              ))}
            </div>
          }
        />
      )}

      <Card>
        <SectionHead
          title={
            <span>
              IP subnets{' '}
              <Typography.Text type="secondary" style={{ fontSize: 14, fontWeight: 400 }}>
                {subnets.length} networks · {connections} documented cables
              </Typography.Text>
            </span>
          }
          extra={
            writable && (
              <Button icon={<PlusOutlined />} onClick={() => setSubnetModal({ open: true })}>
                Add subnet
              </Button>
            )
          }
        />
        <Table<Subnet>
          rowKey="id"
          dataSource={subnets}
          pagination={false}
          size="middle"
          scroll={{ x: 700 }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No subnets yet – add the networks of this plant to see used and free addresses." /> }}
          onRow={(s) => ({ onClick: () => setDetail(s.id), style: { cursor: 'pointer' } })}
          columns={[
            {
              title: 'Network',
              key: 'cidr',
              render: (_, s) => (
                <div>
                  <div className="mono" style={{ fontWeight: 650 }}>
                    {s.cidr}
                  </div>
                  <div className="muted" style={{ fontSize: 13 }}>
                    {s.name}
                  </div>
                </div>
              ),
            },
            { title: 'VLAN', key: 'vlan', width: 160, render: (_, s) => (s.vlan_vid ? `${s.vlan_vid} · ${s.vlan_name}` : <span className="muted">–</span>) },
            { title: 'Gateway', key: 'gateway', width: 140, render: (_, s) => (s.gateway ? <span className="mono">{s.gateway}</span> : <span className="muted">–</span>) },
            {
              title: 'Usage',
              key: 'usage',
              width: 220,
              render: (_, s) => (
                <Space direction="vertical" size={2}>
                  <Usage s={s} />
                  {s.duplicates > 0 && <Tag color="red">{s.duplicates} duplicate IP{s.duplicates > 1 ? 's' : ''}</Tag>}
                </Space>
              ),
            },
            ...(writable
              ? [
                  {
                    title: '',
                    key: 'actions',
                    width: 60,
                    render: (_: unknown, s: Subnet) => (
                      <Button
                        type="text"
                        icon={<EditOutlined />}
                        aria-label={`Edit ${s.cidr}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSubnetModal({ open: true, subnet: s });
                        }}
                      />
                    ),
                  },
                ]
              : []),
          ]}
        />
        {unassigned.length > 0 && (
          <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
            {unassigned.length} device{unassigned.length > 1 ? 's have addresses' : ' has an address'} outside of these subnets:{' '}
            {unassigned.slice(0, 8).map((a, i) => (
              <span key={a.id}>
                {i > 0 && ', '}
                <Link to={`/assets/${a.id}`}>{a.name}</Link> <span className="mono">({a.ip_address})</span>
              </span>
            ))}
            {unassigned.length > 8 && ' …'}
          </Typography.Paragraph>
        )}
      </Card>

      <Card>
        <SectionHead
          title="VLANs"
          extra={
            writable && (
              <Button icon={<PlusOutlined />} onClick={() => setVlanModal({ open: true })}>
                Add VLAN
              </Button>
            )
          }
        />
        <Table<Vlan>
          rowKey="id"
          dataSource={vlans}
          pagination={false}
          size="small"
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No VLANs yet" /> }}
          columns={[
            { title: 'ID', dataIndex: 'vid', width: 80, render: (v) => <span className="mono" style={{ fontWeight: 650 }}>{v}</span> },
            { title: 'Name', dataIndex: 'name' },
            { title: 'Subnets', dataIndex: 'subnet_count', width: 90 },
            { title: 'Ports', dataIndex: 'port_count', width: 90 },
            { title: 'Description', dataIndex: 'description', responsive: ['md'], render: (v) => v ?? <span className="muted">–</span> },
            ...(writable
              ? [
                  {
                    title: '',
                    key: 'actions',
                    width: 90,
                    render: (_: unknown, v: Vlan) => (
                      <Space size={0}>
                        <Button type="text" size="small" icon={<EditOutlined />} aria-label={`Edit VLAN ${v.vid}`} onClick={() => setVlanModal({ open: true, vlan: v })} />
                        <Popconfirm title={`Delete VLAN ${v.vid}?`} description="Subnets keep their addresses." onConfirm={() => removeVlan(v)}>
                          <Button type="text" size="small" danger icon={<DeleteOutlined />} aria-label={`Delete VLAN ${v.vid}`} />
                        </Popconfirm>
                      </Space>
                    ),
                  },
                ]
              : []),
          ]}
        />
      </Card>

      <SubnetModal plantId={plantId} vlans={vlans} state={subnetModal} onClose={() => setSubnetModal({ open: false })} />
      <VlanModal plantId={plantId} state={vlanModal} onClose={() => setVlanModal({ open: false })} />
      <SubnetDrawer id={detail} onClose={() => setDetail(null)} />
    </div>
  );
}

function SubnetDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const q = useQuery({ queryKey: ['subnet', id ?? ''], queryFn: () => http.get<SubnetDetail>(`/api/subnets/${id}`), enabled: !!id });
  const s = q.data;
  return (
    <Drawer open={!!id} onClose={onClose} width={560} title={s ? `${s.cidr} · ${s.name}` : 'Subnet'}>
      {!s ? (
        <Skeleton active />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <Row gutter={16}>
            <Col span={12}>
              <div className="muted">Gateway</div>
              <div className="mono">{s.gateway ?? '–'}</div>
            </Col>
            <Col span={12}>
              <div className="muted">Next free address</div>
              <Typography.Text className="mono" copyable={!!s.nextFree}>
                {s.nextFree ?? '–'}
              </Typography.Text>
            </Col>
            {s.dhcp_range && (
              <Col span={24} style={{ marginTop: 10 }}>
                <div className="muted">DHCP range</div>
                <div className="mono">{s.dhcp_range}</div>
              </Col>
            )}
          </Row>
          <Usage s={s} />
          <div>
            <Typography.Text strong>Used addresses</Typography.Text>
            <Table
              rowKey={(r) => `${r.ip}-${r.asset_id}`}
              size="small"
              pagination={false}
              dataSource={s.addresses}
              style={{ marginTop: 8 }}
              locale={{ emptyText: 'No device uses an address of this network yet.' }}
              columns={[
                {
                  title: 'IP',
                  dataIndex: 'ip',
                  width: 140,
                  render: (ip, r) => (
                    <span className="mono" style={{ color: r.duplicate ? '#cf1322' : undefined, fontWeight: r.duplicate ? 650 : undefined }}>
                      {ip}
                    </span>
                  ),
                },
                {
                  title: 'Device',
                  key: 'asset',
                  render: (_, r) => (
                    <Space>
                      <TypeIcon type={r.asset_type} />
                      <Link to={`/assets/${r.asset_id}`}>{r.asset_name}</Link>
                      {r.duplicate && <Tag color="red">duplicate</Tag>}
                    </Space>
                  ),
                },
                { title: 'Status', key: 'status', width: 130, render: (_, r) => <StatusDot status={r.asset_status} /> },
              ]}
            />
          </div>
          {s.free.length > 0 && (
            <div>
              <Typography.Text strong>Free ranges</Typography.Text>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                {s.free.map((f) => (
                  <Tag key={f.from} className="mono">
                    {f.from === f.to ? f.from : `${f.from} – ${f.to}`} ({f.count})
                  </Tag>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}

function SubnetModal({ plantId, vlans, state, onClose }: { plantId: string; vlans: Vlan[]; state: { open: boolean; subnet?: Subnet }; onClose: () => void }) {
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const invalidate = useInvalidate();
  const [saving, setSaving] = useState(false);
  const s = state.subnet;
  useEffect(() => {
    if (state.open) form.setFieldsValue(s ? { ...s } : { cidr: '', name: '', vlan_id: undefined, gateway: '', dhcp_range: '', description: '' });
  }, [state.open, s, form]);
  const remove = async () => {
    try {
      await http.del(`/api/subnets/${s!.id}`);
      message.success(`${s!.cidr} deleted`);
      await invalidate();
      onClose();
    } catch (e) {
      message.error(errorText(e));
    }
  };
  return (
    <Modal
      open={state.open}
      title={s ? `Edit ${s.cidr}` : 'Add subnet'}
      okText="Save"
      confirmLoading={saving}
      onCancel={onClose}
      destroyOnHidden
      footer={(_, { OkBtn, CancelBtn }) => (
        <div style={{ display: 'flex', gap: 8 }}>
          {s && (
            <Popconfirm title={`Delete ${s.cidr}?`} description="Devices keep their IP addresses." onConfirm={remove}>
              <Button danger icon={<DeleteOutlined />}>
                Delete
              </Button>
            </Popconfirm>
          )}
          <div style={{ flex: 1 }} />
          <CancelBtn />
          <OkBtn />
        </div>
      )}
      onOk={async () => {
        const v = await form.validateFields();
        setSaving(true);
        try {
          const body = { plant_id: plantId, cidr: v.cidr, name: v.name, vlan_id: v.vlan_id ?? null, gateway: v.gateway || null, dhcp_range: v.dhcp_range || null, description: v.description || null };
          if (s) await http.put(`/api/subnets/${s.id}`, body);
          else await http.post('/api/subnets', body);
          message.success('Subnet saved');
          await invalidate();
          onClose();
        } catch (e) {
          message.error(errorText(e));
        } finally {
          setSaving(false);
        }
      }}
    >
      <Form form={form} layout="vertical">
        <Row gutter={12}>
          <Col xs={24} md={12}>
            <Form.Item name="cidr" label="Network" rules={[{ required: true, whitespace: true, message: 'e.g. 10.10.20.0/24' }]}>
              <Input className="mono" placeholder="10.10.20.0/24" autoFocus />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="name" label="Name" rules={[{ required: true, whitespace: true }]}>
              <Input placeholder="e.g. Office clients" />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="vlan_id" label="VLAN">
              <Select allowClear placeholder="–" options={vlans.map((v) => ({ value: v.id, label: `${v.vid} · ${v.name}` }))} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="gateway" label="Gateway">
              <Input className="mono" placeholder="10.10.20.1" />
            </Form.Item>
          </Col>
          <Col span={24}>
            <Form.Item name="dhcp_range" label="DHCP range">
              <Input className="mono" placeholder="e.g. 10.10.20.100 – 10.10.20.199" />
            </Form.Item>
          </Col>
          <Col span={24}>
            <Form.Item name="description" label="Description">
              <Input.TextArea autoSize={{ minRows: 1, maxRows: 4 }} />
            </Form.Item>
          </Col>
        </Row>
      </Form>
    </Modal>
  );
}

function VlanModal({ plantId, state, onClose }: { plantId: string; state: { open: boolean; vlan?: Vlan }; onClose: () => void }) {
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const invalidate = useInvalidate();
  const [saving, setSaving] = useState(false);
  const v0 = state.vlan;
  useEffect(() => {
    if (state.open) form.setFieldsValue(v0 ? { ...v0 } : { vid: undefined, name: '', description: '' });
  }, [state.open, v0, form]);
  return (
    <Modal
      open={state.open}
      title={v0 ? `Edit VLAN ${v0.vid}` : 'Add VLAN'}
      okText="Save"
      confirmLoading={saving}
      onCancel={onClose}
      destroyOnHidden
      onOk={async () => {
        const v = await form.validateFields();
        setSaving(true);
        try {
          const body = { vid: v.vid, name: v.name, description: v.description || null };
          if (v0) await http.put(`/api/vlans/${v0.id}`, body);
          else await http.post('/api/vlans', { ...body, plant_id: plantId });
          message.success('VLAN saved');
          await invalidate();
          onClose();
        } catch (e) {
          message.error(errorText(e));
        } finally {
          setSaving(false);
        }
      }}
    >
      <Form form={form} layout="vertical">
        <Row gutter={12}>
          <Col span={8}>
            <Form.Item name="vid" label="VLAN ID" rules={[{ required: true, message: '1–4094' }]}>
              <InputNumber min={1} max={4094} style={{ width: '100%' }} autoFocus />
            </Form.Item>
          </Col>
          <Col span={16}>
            <Form.Item name="name" label="Name" rules={[{ required: true, whitespace: true }]}>
              <Input placeholder="e.g. Production" />
            </Form.Item>
          </Col>
          <Col span={24}>
            <Form.Item name="description" label="Description">
              <Input />
            </Form.Item>
          </Col>
        </Row>
      </Form>
    </Modal>
  );
}
