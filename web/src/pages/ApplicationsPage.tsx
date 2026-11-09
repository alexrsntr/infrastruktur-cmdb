import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { App, Button, Card, Col, Empty, Form, Input, Modal, Popconfirm, Result, Row, Select, Skeleton, Space, Table, Tag, Timeline, Typography } from 'antd';
import { BlockOutlined, DeleteOutlined, EditOutlined, LinkOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons';
import { APP_STATUSES, APP_STATUS_META, type Application, type ApplicationDetail } from '../../../shared/applications';
import { CRITICALITIES, CRITICALITY_META, RELATION_TYPES, type AssetType, type AuditEntry } from '../../../shared/model';
import { errorText, http } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { useInvalidate, usePlants } from '../lib/queries';
import { useSession } from '../lib/session';
import { PageHeader } from '../components/PageHeader';
import { StatusDot, TypeIcon } from '../components/Simple';

const useApplications = () => useQuery({ queryKey: ['applications'], queryFn: () => http.get<Application[]>('/api/applications') });

function CritTag({ value }: { value: Application['criticality'] }) {
  return <Tag color={CRITICALITY_META[value].color}>{CRITICALITY_META[value].label}</Tag>;
}

/** Business applications / IT services and the devices they run on */
export function ApplicationsPage() {
  const { can } = useSession();
  const navigate = useNavigate();
  const apps = useApplications();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(false);
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (apps.data ?? []).filter((a) => !s || [a.name, a.owner, a.plant_code, a.description].some((v) => v?.toLowerCase().includes(s)));
  }, [apps.data, q]);

  return (
    <div>
      <PageHeader
        title="Applications"
        subtitle="Business applications and IT services, and the devices they run on. A device page shows which applications are affected when it fails."
        extra={
          can('asset.write') && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing(true)}>
              Add application
            </Button>
          )
        }
      />
      <Card>
        <Input allowClear prefix={<SearchOutlined className="muted" />} placeholder="Search name, owner, plant…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 340, marginBottom: 16 }} />
        <Table<Application>
          rowKey="id"
          loading={apps.isLoading}
          dataSource={rows}
          pagination={rows.length > 50 ? { pageSize: 50 } : false}
          onRow={(a) => ({ onClick: () => navigate(`/applications/${a.id}`), style: { cursor: 'pointer' } })}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No applications yet" /> }}
          columns={[
            {
              title: 'Application',
              key: 'name',
              render: (_, a) => (
                <div>
                  <div style={{ fontWeight: 650, fontSize: 15.5 }}>{a.name}</div>
                  {a.description && (
                    <Typography.Text type="secondary" ellipsis style={{ maxWidth: 480, display: 'block', fontSize: 13 }}>
                      {a.description}
                    </Typography.Text>
                  )}
                </div>
              ),
            },
            { title: 'Criticality', key: 'crit', width: 120, render: (_, a) => <CritTag value={a.criticality} /> },
            { title: 'Status', key: 'status', width: 120, render: (_, a) => <Tag color={APP_STATUS_META[a.status].color}>{APP_STATUS_META[a.status].label}</Tag> },
            { title: 'Plant', key: 'plant', width: 140, responsive: ['md'], render: (_, a) => a.plant_code ?? <span className="muted">All plants</span> },
            { title: 'Owner', dataIndex: 'owner', width: 200, responsive: ['lg'], render: (v) => v ?? <span className="muted">–</span> },
            { title: 'Devices', dataIndex: 'asset_count', width: 90 },
          ]}
        />
      </Card>
      <ApplicationFormModal open={editing} onClose={() => setEditing(false)} onSaved={(a) => navigate(`/applications/${a.id}`)} />
    </div>
  );
}

function ApplicationFormModal({ open, app, onClose, onSaved }: { open: boolean; app?: Application; onClose: () => void; onSaved?: (a: Application) => void }) {
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const invalidate = useInvalidate();
  const plants = usePlants();
  const { scoped, me } = useSession();
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open)
      form.setFieldsValue(
        app ?? { name: '', status: 'production', criticality: 'medium', plant_id: scoped && me.user.plantScope.length === 1 ? me.user.plantScope[0] : undefined, owner: '', url: '', description: '' },
      );
  }, [open, app, form, scoped, me.user.plantScope]);
  return (
    <Modal
      open={open}
      title={app ? `Edit ${app.name}` : 'Add application'}
      okText="Save"
      confirmLoading={saving}
      onCancel={onClose}
      width={640}
      destroyOnHidden
      onOk={async () => {
        const v = await form.validateFields();
        setSaving(true);
        try {
          const body = { ...v, plant_id: v.plant_id ?? null, owner: v.owner || null, url: v.url || null, description: v.description || null };
          const saved = app ? await http.put<Application>(`/api/applications/${app.id}`, body) : await http.post<Application>('/api/applications', body);
          message.success(`${saved.name} saved`);
          await invalidate();
          onClose();
          onSaved?.(saved);
        } catch (e) {
          message.error(errorText(e));
        } finally {
          setSaving(false);
        }
      }}
    >
      <Form form={form} layout="vertical">
        <Row gutter={12}>
          <Col span={24}>
            <Form.Item name="name" label="Name" rules={[{ required: true, whitespace: true, max: 200 }]}>
              <Input placeholder="e.g. MES, SAP ERP, File services" autoFocus />
            </Form.Item>
          </Col>
          <Col xs={12} md={8}>
            <Form.Item name="criticality" label="Criticality">
              <Select options={CRITICALITIES.map((c) => ({ value: c, label: CRITICALITY_META[c].label }))} />
            </Form.Item>
          </Col>
          <Col xs={12} md={8}>
            <Form.Item name="status" label="Status">
              <Select options={APP_STATUSES.map((s) => ({ value: s, label: APP_STATUS_META[s].label }))} />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="plant_id" label="Plant" extra="Empty = used by all plants">
              <Select allowClear placeholder="All plants" options={(plants.data ?? []).map((p) => ({ value: p.id, label: `${p.code} – ${p.name}` }))} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="owner" label="Owner / responsible">
              <Input />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="url" label="Link" rules={[{ pattern: /^https?:\/\//i, message: 'Start with http:// or https://' }]}>
              <Input placeholder="https://" />
            </Form.Item>
          </Col>
          <Col span={24}>
            <Form.Item name="description" label="Description">
              <Input.TextArea autoSize={{ minRows: 2, maxRows: 6 }} />
            </Form.Item>
          </Col>
        </Row>
      </Form>
    </Modal>
  );
}

interface AssetOption {
  id: string;
  name: string;
  type: AssetType;
  plant_code: string | null;
}

function LinkDeviceModal({ open, appId, onClose }: { open: boolean; appId: string; onClose: () => void }) {
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const invalidate = useInvalidate();
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const options = useQuery({ queryKey: ['asset-options', search], queryFn: () => http.get<AssetOption[]>('/api/assets/options', { q: search || undefined }), enabled: open });
  return (
    <Modal
      open={open}
      title="Add device"
      okText="Add"
      confirmLoading={saving}
      onCancel={onClose}
      destroyOnHidden
      onOk={async () => {
        const v = await form.validateFields();
        setSaving(true);
        try {
          await http.post(`/api/applications/${appId}/assets`, { asset_id: v.asset_id, role: v.role || null });
          message.success('Device added');
          await invalidate();
          form.resetFields();
          onClose();
        } catch (e) {
          message.error(errorText(e));
        } finally {
          setSaving(false);
        }
      }}
    >
      <Form form={form} layout="vertical">
        <Form.Item name="asset_id" label="Device" rules={[{ required: true, message: 'Choose a device' }]}>
          <Select
            showSearch
            filterOption={false}
            onSearch={setSearch}
            placeholder="Search by name or IP"
            loading={options.isFetching}
            options={(options.data ?? []).map((o) => ({ value: o.id, label: `${o.name}${o.plant_code ? ` · ${o.plant_code}` : ''}` }))}
          />
        </Form.Item>
        <Form.Item name="role" label="Role">
          <Input placeholder="e.g. Application server, Database, Load balancer" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

export function ApplicationPage() {
  const { applicationId } = useParams();
  const { can } = useSession();
  const { message } = App.useApp();
  const navigate = useNavigate();
  const invalidate = useInvalidate();
  const [editing, setEditing] = useState(false);
  const [linking, setLinking] = useState(false);
  const q = useQuery({ queryKey: ['application', applicationId], queryFn: () => http.get<ApplicationDetail>(`/api/applications/${applicationId}`) });
  const history = useQuery({ queryKey: ['application-history', applicationId], queryFn: () => http.get<AuditEntry[]>(`/api/applications/${applicationId}/history`) });

  if (q.isLoading) return <Skeleton active paragraph={{ rows: 10 }} />;
  if (q.isError || !q.data)
    return <Result status="404" title="Application not found" extra={<Button onClick={() => navigate('/applications')}>Back to applications</Button>} />;
  const a = q.data;
  const writable = can('asset.write');

  const unlink = async (assetId: string) => {
    try {
      await http.del(`/api/applications/${a.id}/assets/${assetId}`);
      await invalidate();
    } catch (e) {
      message.error(errorText(e));
    }
  };
  const remove = async () => {
    try {
      await http.del(`/api/applications/${a.id}`);
      message.success(`${a.name} deleted`);
      await invalidate();
      navigate('/applications');
    } catch (e) {
      message.error(errorText(e));
    }
  };

  return (
    <div>
      <PageHeader
        icon={
          <span className="type-icon lg" style={{ background: '#2563eb' }}>
            <BlockOutlined />
          </span>
        }
        title={a.name}
        crumbs={[{ title: 'Applications', to: '/applications' }]}
        subtitle={[a.plant_code ? `${a.plant_code} – ${a.plant_name}` : 'All plants', a.owner].filter(Boolean).join(' · ')}
        tags={
          <Space size={4}>
            <CritTag value={a.criticality} />
            <Tag color={APP_STATUS_META[a.status].color}>{APP_STATUS_META[a.status].label}</Tag>
          </Space>
        }
        extra={
          <Space>
            {writable && (
              <Button icon={<EditOutlined />} onClick={() => setEditing(true)}>
                Edit
              </Button>
            )}
            {can('asset.delete') && (
              <Popconfirm title={`Delete ${a.name}?`} description="The devices stay in the CMDB." onConfirm={remove}>
                <Button danger icon={<DeleteOutlined />}>
                  Delete
                </Button>
              </Popconfirm>
            )}
          </Space>
        }
      />
      <Row gutter={[20, 20]}>
        <Col xs={24} xl={15}>
          <Card
            title={`Runs on (${a.assets.length})`}
            extra={
              writable && (
                <Button icon={<LinkOutlined />} onClick={() => setLinking(true)}>
                  Add device
                </Button>
              )
            }
            style={{ marginBottom: 20 }}
          >
            <Table
              rowKey="asset_id"
              size="middle"
              pagination={false}
              dataSource={a.assets}
              locale={{ emptyText: 'Add the servers, VMs and other devices this application runs on.' }}
              columns={[
                {
                  title: 'Device',
                  key: 'name',
                  render: (_, d) => (
                    <Space>
                      <TypeIcon type={d.type} />
                      <span>
                        <Link to={`/assets/${d.asset_id}`} style={{ fontWeight: 600 }}>
                          {d.name}
                        </Link>
                        <div className="muted" style={{ fontSize: 12.5 }}>
                          {[d.role, d.plant_code, d.ip_address].filter(Boolean).join(' · ')}
                        </div>
                      </span>
                    </Space>
                  ),
                },
                { title: 'Status', key: 'status', width: 140, render: (_, d) => <StatusDot status={d.status} /> },
                ...(writable
                  ? [
                      {
                        title: '',
                        key: 'x',
                        width: 50,
                        render: (_: unknown, d: ApplicationDetail['assets'][number]) => (
                          <Popconfirm title={`Remove ${d.name} from ${a.name}?`} onConfirm={() => unlink(d.asset_id)}>
                            <Button type="text" danger icon={<DeleteOutlined />} aria-label={`Remove ${d.name}`} />
                          </Popconfirm>
                        ),
                      },
                    ]
                  : []),
              ]}
            />
          </Card>
          <Card title={`Depends on infrastructure (${a.dependencies.length})`}>
            <Typography.Paragraph type="secondary">
              Hosts, switches, UPS and other devices the application devices need (uplinks, hosts, power supply and documented dependencies). If one of them fails, this
              application is affected.
            </Typography.Paragraph>
            <Table
              rowKey="id"
              size="small"
              pagination={a.dependencies.length > 30 ? { pageSize: 30 } : false}
              dataSource={a.dependencies}
              locale={{ emptyText: 'No dependencies documented yet – add relations such as “Runs on” or “Powered by” on the device pages.' }}
              columns={[
                {
                  title: 'Device',
                  key: 'name',
                  render: (_, d) => (
                    <Space>
                      <TypeIcon type={d.type} />
                      <Link to={`/assets/${d.id}`}>{d.name}</Link>
                    </Space>
                  ),
                },
                { title: 'Needed by', key: 'via', render: (_, d) => <span className="muted">{`${d.via_name} ${RELATION_TYPES[d.relation].label.toLowerCase()} ${d.name}`}</span> },
                { title: 'Status', key: 'status', width: 140, render: (_, d) => <StatusDot status={d.status} /> },
              ]}
            />
          </Card>
        </Col>
        <Col xs={24} xl={9}>
          <Card title="About" style={{ marginBottom: 20 }}>
            {a.description ? <Typography.Paragraph style={{ whiteSpace: 'pre-wrap' }}>{a.description}</Typography.Paragraph> : <Typography.Paragraph type="secondary">No description.</Typography.Paragraph>}
            {a.url && (
              <a href={a.url} target="_blank" rel="noopener noreferrer">
                {a.url}
              </a>
            )}
          </Card>
          <Card title="History">
            {history.data?.length ? (
              <Timeline
                items={history.data.slice(0, 20).map((h) => ({
                  children: (
                    <div>
                      <div>
                        {h.action === 'application.link' ? `Device added: ${String(h.changes?.device ?? '')}` : h.action === 'application.unlink' ? `Device removed: ${String(h.changes?.device ?? '')}` : h.action === 'create' ? 'Created' : h.action === 'update' ? `Changed ${Object.keys(h.changes ?? {}).join(', ')}` : h.action}
                      </div>
                      <div className="muted" style={{ fontSize: 12.5 }}>
                        {fmtDateTime(h.at)}
                        {h.user_name ? ` · ${h.user_name}` : ''}
                      </div>
                    </div>
                  ),
                }))}
              />
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />
            )}
          </Card>
        </Col>
      </Row>
      <ApplicationFormModal open={editing} app={a} onClose={() => setEditing(false)} />
      <LinkDeviceModal open={linking} appId={a.id} onClose={() => setLinking(false)} />
    </div>
  );
}
