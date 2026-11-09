import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  App,
  Badge,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Result,
  Row,
  Segmented,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { CheckOutlined, DeleteOutlined, EditOutlined, EyeInvisibleOutlined, LinkOutlined, PlayCircleOutlined, PlusOutlined, UndoOutlined } from '@ant-design/icons';
import {
  DISCOVERY_KIND_META,
  SNMP_AUTH_PROTOCOLS,
  SNMP_LEVELS,
  SNMP_PRIV_PROTOCOLS,
  type AdConfig,
  type DiscoveryItem,
  type DiscoveryKind,
  type DiscoveryRun,
  type DiscoverySource,
  type DiscoveryState,
  type SnmpConfig,
} from '../../../shared/discovery';
import { ASSET_TYPES, ASSET_TYPE_KEYS, type AssetType } from '../../../shared/model';
import { errorText, http } from '../lib/api';
import { fmtDateTime, fromNow } from '../lib/format';
import { useAssetTypes, useBuildings, useInvalidate, usePlants } from '../lib/queries';
import { useSession } from '../lib/session';
import { PageHeader } from '../components/PageHeader';
import { TypeIcon } from '../components/Simple';

/** Auto-discovery: inbox of discovered devices and (for administrators) the sources */
export function DiscoveryPage() {
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  if (!can('asset.write')) return <Result status="403" title="No access" subTitle="Discovered devices can be reviewed by editors and administrators." />;
  const tab = params.get('tab') ?? 'inbox';
  return (
    <div>
      <PageHeader
        title="Discovered devices"
        subtitle="Devices found in the network (SNMP) and in Active Directory. Known devices are updated automatically – only empty fields are filled; new ones wait here until you add, link or ignore them."
        crumbs={[{ title: 'Administration' }, { title: 'Discovery' }]}
      />
      <Card styles={{ body: { paddingTop: 0 } }}>
        <Tabs
          activeKey={tab}
          onChange={(k) => setParams(k === 'inbox' ? {} : { tab: k }, { replace: true })}
          items={[
            { key: 'inbox', label: 'Inbox', children: <Inbox /> },
            ...(can('settings.manage') ? [{ key: 'sources', label: 'Sources & runs', children: <Sources /> }] : []),
          ]}
        />
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------- inbox

function Inbox() {
  const { message } = App.useApp();
  const invalidate = useInvalidate();
  const [state, setState] = useState<DiscoveryState>('new');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState<DiscoveryItem | null>(null);
  const [linking, setLinking] = useState<DiscoveryItem | null>(null);
  const [detail, setDetail] = useState<DiscoveryItem | null>(null);
  const items = useQuery({
    queryKey: ['discovery-items', state, q],
    queryFn: () => http.get<{ items: DiscoveryItem[]; counts: Record<DiscoveryState, number> }>('/api/discovery/items', { state, q: q || undefined }),
  });
  const act = async (item: DiscoveryItem, action: 'ignore' | 'reset') => {
    try {
      await http.post(`/api/discovery/items/${item.id}/${action}`);
      await invalidate();
    } catch (e) {
      message.error(errorText(e));
    }
  };
  const counts = items.data?.counts;

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', margin: '4px 0 16px', alignItems: 'center' }}>
        <Segmented
          value={state}
          onChange={(v) => setState(v as DiscoveryState)}
          options={[
            { value: 'new', label: <span>New {counts ? <Badge count={counts.new} showZero color={counts.new ? '#2563eb' : '#bbb'} /> : null}</span> },
            { value: 'linked', label: `Linked${counts ? ` (${counts.linked})` : ''}` },
            { value: 'ignored', label: `Ignored${counts ? ` (${counts.ignored})` : ''}` },
          ]}
        />
        <Input.Search allowClear placeholder="Search name, IP, serial…" style={{ width: 300 }} onSearch={setQ} />
      </div>
      <Table<DiscoveryItem>
        rowKey="id"
        loading={items.isLoading}
        dataSource={items.data?.items ?? []}
        pagination={{ pageSize: 50, hideOnSinglePage: true }}
        scroll={{ x: 900 }}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={state === 'new' ? 'Nothing new – every discovered device is in the CMDB or ignored.' : 'Nothing here.'}
            />
          ),
        }}
        onRow={(i) => ({ onClick: () => setDetail(i), style: { cursor: 'pointer' } })}
        columns={[
          {
            title: 'Discovered',
            key: 'name',
            render: (_, i) => (
              <Space>
                <TypeIcon type={i.data.type} />
                <span>
                  <div style={{ fontWeight: 650 }}>{i.data.name ?? i.data.ip}</div>
                  <div className="muted" style={{ fontSize: 12.5 }}>
                    {[ASSET_TYPES[i.data.type]?.label, i.data.manufacturer, i.data.model].filter(Boolean).join(' · ')}
                  </div>
                </span>
              </Space>
            ),
          },
          {
            title: 'Address',
            key: 'ip',
            width: 210,
            render: (_, i) => (
              <div className="mono" style={{ fontSize: 13 }}>
                {i.data.ip ?? i.data.fqdn ?? '–'}
                {i.data.serial && <div className="muted">SN {i.data.serial}</div>}
              </div>
            ),
          },
          {
            title: 'Source',
            key: 'source',
            width: 200,
            render: (_, i) => (
              <div>
                {i.source_name}
                <div className="muted" style={{ fontSize: 12.5 }}>
                  seen {fromNow(i.last_seen)}
                </div>
              </div>
            ),
          },
          ...(state === 'linked'
            ? [
                {
                  title: 'In the CMDB',
                  key: 'asset',
                  width: 220,
                  render: (_: unknown, i: DiscoveryItem) =>
                    i.asset_id ? (
                      <span onClick={(e) => e.stopPropagation()}>
                        <Link to={`/assets/${i.asset_id}`}>{i.asset_name}</Link>
                        {i.matched_by && <Tag style={{ marginInlineStart: 6 }}>by {i.matched_by}</Tag>}
                      </span>
                    ) : (
                      <span className="muted">deleted</span>
                    ),
                },
              ]
            : []),
          {
            title: '',
            key: 'actions',
            width: state === 'new' ? 280 : 120,
            align: 'right',
            render: (_, i) => (
              <Space onClick={(e) => e.stopPropagation()}>
                {state === 'new' && (
                  <>
                    <Button type="primary" size="small" icon={<CheckOutlined />} onClick={() => setCreating(i)}>
                      Add
                    </Button>
                    <Button size="small" icon={<LinkOutlined />} onClick={() => setLinking(i)}>
                      Link
                    </Button>
                    <Tooltip title="Ignore – it will not show up again">
                      <Button size="small" icon={<EyeInvisibleOutlined />} aria-label="Ignore" onClick={() => act(i, 'ignore')} />
                    </Tooltip>
                  </>
                )}
                {state !== 'new' && (
                  <Tooltip title="Back to the inbox">
                    <Button size="small" icon={<UndoOutlined />} onClick={() => act(i, 'reset')}>
                      Reset
                    </Button>
                  </Tooltip>
                )}
              </Space>
            ),
          },
        ]}
      />
      <CreateModal item={creating} onClose={() => setCreating(null)} />
      <LinkModal item={linking} onClose={() => setLinking(null)} />
      <ItemDrawer item={detail} onClose={() => setDetail(null)} />
    </div>
  );
}

function ItemDrawer({ item, onClose }: { item: DiscoveryItem | null; onClose: () => void }) {
  const d = item?.data;
  return (
    <Drawer open={!!item} onClose={onClose} width={620} title={d ? (d.name ?? d.ip) : ''}>
      {d && (
        <Space direction="vertical" size={18} style={{ width: '100%' }}>
          <Descriptions
            column={1}
            size="small"
            bordered
            items={[
              ['Type (guess)', ASSET_TYPES[d.type]?.label],
              ['IP address', d.ip],
              ['Host name', d.fqdn],
              ['Manufacturer', d.manufacturer],
              ['Model', d.model],
              ['Serial number', d.serial],
              ['MAC address', d.mac],
              ['Firmware / OS', d.os ?? d.firmware],
              ['Location (SNMP)', d.location],
              ['Last logon (AD)', d.last_logon ? fmtDateTime(d.last_logon) : null],
              ['System description', d.description],
              ['sysObjectID', d.sys_object_id],
            ]
              .filter(([, v]) => v)
              .map(([k, v]) => ({ key: k as string, label: k, children: <span className="mono" style={{ wordBreak: 'break-word' }}>{v}</span> }))}
          />
          {!!d.ports?.length && (
            <div>
              <Typography.Text strong>Ports ({d.ports.length})</Typography.Text>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                {d.ports.slice(0, 120).map((p) => (
                  <Tooltip key={p.name} title={[p.description, p.speed, p.mac].filter(Boolean).join(' · ')}>
                    <Tag className="mono">{p.name}</Tag>
                  </Tooltip>
                ))}
              </div>
            </div>
          )}
          {!!d.neighbors?.length && (
            <div>
              <Typography.Text strong>LLDP neighbours</Typography.Text>
              <Table
                size="small"
                pagination={false}
                rowKey={(n) => `${n.local_port}-${n.remote_name}-${n.remote_port}`}
                dataSource={d.neighbors}
                style={{ marginTop: 6 }}
                columns={[
                  { title: 'Local port', dataIndex: 'local_port', render: (v) => <span className="mono">{v}</span> },
                  { title: 'Neighbour', dataIndex: 'remote_name' },
                  { title: 'Remote port', dataIndex: 'remote_port', render: (v) => <span className="mono">{v}</span> },
                ]}
              />
            </div>
          )}
        </Space>
      )}
    </Drawer>
  );
}

function CreateModal({ item, onClose }: { item: DiscoveryItem | null; onClose: () => void }) {
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const invalidate = useInvalidate();
  const plants = usePlants();
  const buildings = useBuildings();
  const types = useAssetTypes();
  const [saving, setSaving] = useState(false);
  const plantId = Form.useWatch('plant_id', form) as string | undefined;
  useEffect(() => {
    if (item) form.setFieldsValue({ name: item.data.name ?? item.data.ip, type: item.data.type, plant_id: item.plant_id ?? undefined, building_id: undefined });
  }, [item, form]);
  return (
    <Modal
      open={!!item}
      title="Add to the CMDB"
      okText="Add device"
      confirmLoading={saving}
      onCancel={onClose}
      destroyOnHidden
      onOk={async () => {
        const v = await form.validateFields();
        setSaving(true);
        try {
          const created = await http.post<{ id: string; name: string }>(`/api/discovery/items/${item!.id}/create`, { ...v, building_id: v.building_id ?? null, plant_id: v.plant_id ?? null });
          message.success(
            <span>
              <Link to={`/assets/${created.id}`}>{created.name}</Link> added
            </span>,
          );
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
        <Form.Item name="name" label="Name" rules={[{ required: true, whitespace: true }]}>
          <Input />
        </Form.Item>
        <Form.Item name="type" label="Type">
          <Select options={ASSET_TYPE_KEYS.filter((t) => types.offered.includes(t) || t === item?.data.type).map((t) => ({ value: t, label: ASSET_TYPES[t].label }))} />
        </Form.Item>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="plant_id" label="Plant">
              <Select allowClear options={(plants.data ?? []).map((p) => ({ value: p.id, label: `${p.code} – ${p.name}` }))} onChange={() => form.setFieldValue('building_id', undefined)} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="building_id" label="Building">
              <Select allowClear disabled={!plantId} options={(buildings.data ?? []).filter((b) => b.plant_id === plantId).map((b) => ({ value: b.id, label: `${b.code} – ${b.name}` }))} />
            </Form.Item>
          </Col>
        </Row>
        <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
          Serial number, model, firmware, ports and LLDP neighbours are taken over. Place it in a rack or on a plan afterwards.
        </Typography.Text>
      </Form>
    </Modal>
  );
}

function LinkModal({ item, onClose }: { item: DiscoveryItem | null; onClose: () => void }) {
  const { message } = App.useApp();
  const invalidate = useInvalidate();
  const [search, setSearch] = useState('');
  const [assetId, setAssetId] = useState<string>();
  const options = useQuery({
    queryKey: ['asset-options', search],
    queryFn: () => http.get<{ id: string; name: string; type: AssetType; plant_code: string | null; ip_address: string | null }[]>('/api/assets/options', { q: search || undefined }),
    enabled: !!item,
  });
  useEffect(() => {
    setAssetId(undefined);
    setSearch(item?.data.name ?? '');
  }, [item]);
  return (
    <Modal
      open={!!item}
      title={`Link ${item?.data.name ?? item?.data.ip ?? ''} with a device`}
      okText="Link"
      okButtonProps={{ disabled: !assetId }}
      onCancel={onClose}
      destroyOnHidden
      onOk={async () => {
        try {
          await http.post(`/api/discovery/items/${item!.id}/link`, { asset_id: assetId });
          message.success('Linked – empty fields were filled');
          await invalidate();
          onClose();
        } catch (e) {
          message.error(errorText(e));
        }
      }}
    >
      <Select
        showSearch
        style={{ width: '100%' }}
        filterOption={false}
        searchValue={search}
        onSearch={setSearch}
        value={assetId}
        onChange={setAssetId}
        placeholder="Search the device in the CMDB"
        loading={options.isFetching}
        options={(options.data ?? []).map((o) => ({ value: o.id, label: `${o.name}${o.ip_address ? ` · ${o.ip_address}` : ''}${o.plant_code ? ` · ${o.plant_code}` : ''}` }))}
      />
    </Modal>
  );
}

// ---------------------------------------------------------------------------- sources

function Sources() {
  const { message } = App.useApp();
  const plants = usePlants();
  const sources = useQuery({ queryKey: ['discovery-sources'], queryFn: () => http.get<DiscoverySource[]>('/api/discovery/sources') });
  const runs = useQuery({ queryKey: ['discovery-runs'], queryFn: () => http.get<DiscoveryRun[]>('/api/discovery/runs'), refetchInterval: (q) => (q.state.data?.some((r) => r.status === 'running') ? 3000 : false) });
  const [editing, setEditing] = useState<{ open: boolean; kind?: DiscoveryKind; source?: DiscoverySource }>({ open: false });
  const invalidate = useInvalidate();

  const run = async (s: DiscoverySource) => {
    try {
      await http.post(`/api/discovery/sources/${s.id}/run`);
      message.info(`${s.name}: run started`);
      setTimeout(() => void invalidate(), 1500);
    } catch (e) {
      message.error(errorText(e));
    }
  };
  const remove = async (s: DiscoverySource) => {
    try {
      await http.del(`/api/discovery/sources/${s.id}`);
      await invalidate();
    } catch (e) {
      message.error(errorText(e));
    }
  };

  return (
    <Space direction="vertical" size={20} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="How discovery works"
        description={
          <span>
            The CMDB itself queries the networks (SNMP v2c/v3, UDP 161) and the domain controllers (LDAPS, TCP 636). When it runs in Azure, the plant networks must
            be reachable through the VPN / ExpressRoute and VNet integration; ICMP is not available in App Service, so devices are found by SNMP. Credentials are
            stored encrypted. Devices are matched by serial number, then MAC address, host name and IP address; existing values are never overwritten.
          </span>
        }
      />
      <div style={{ display: 'flex', gap: 8 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing({ open: true, kind: 'snmp' })}>
          SNMP network scan
        </Button>
        <Button icon={<PlusOutlined />} onClick={() => setEditing({ open: true, kind: 'ad' })}>
          Active Directory
        </Button>
      </div>
      <Table<DiscoverySource>
        rowKey="id"
        loading={sources.isLoading}
        dataSource={sources.data ?? []}
        pagination={false}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No sources yet" /> }}
        columns={[
          {
            title: 'Source',
            key: 'name',
            render: (_, s) => (
              <div style={{ opacity: s.enabled ? 1 : 0.55 }}>
                <Typography.Text strong>{s.name}</Typography.Text> <Tag>{DISCOVERY_KIND_META[s.kind].label}</Tag>
                <div className="muted mono" style={{ fontSize: 12 }}>
                  {s.kind === 'snmp' ? `${(s.config as SnmpConfig).targets} · v${(s.config as SnmpConfig).version}` : (s.config as AdConfig).url}
                </div>
              </div>
            ),
          },
          { title: 'Plant', key: 'plant', width: 90, render: (_, s) => s.plant_code ?? <span className="muted">–</span> },
          { title: 'Schedule', key: 'sched', width: 130, render: (_, s) => (s.schedule_hours ? `every ${s.schedule_hours} h` : <span className="muted">manual</span>) },
          {
            title: 'Last run',
            key: 'last',
            render: (_, s) =>
              s.last_run_at ? (
                <div>
                  <span style={{ color: s.last_status?.startsWith('Failed') ? '#cf1322' : undefined }}>{s.last_status}</span>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {fromNow(s.last_run_at)}
                  </div>
                </div>
              ) : (
                <span className="muted">never</span>
              ),
          },
          { title: 'New', key: 'new', width: 70, render: (_, s) => (s.new_items ? <Badge count={s.new_items} color="#2563eb" /> : <span className="muted">0</span>) },
          {
            title: '',
            key: 'x',
            width: 140,
            render: (_, s) => (
              <Space size={0}>
                <Tooltip title="Run now">
                  <Button type="text" icon={<PlayCircleOutlined />} aria-label={`Run ${s.name}`} onClick={() => run(s)} />
                </Tooltip>
                <Button type="text" icon={<EditOutlined />} aria-label={`Edit ${s.name}`} onClick={() => setEditing({ open: true, kind: s.kind, source: s })} />
                <Popconfirm title={`Delete ${s.name}?`} description="Its inbox entries are deleted too; devices stay." onConfirm={() => remove(s)}>
                  <Button type="text" danger icon={<DeleteOutlined />} aria-label={`Delete ${s.name}`} />
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <div>
        <Typography.Title level={5}>Recent runs</Typography.Title>
        <Table<DiscoveryRun>
          rowKey="id"
          size="small"
          dataSource={runs.data ?? []}
          pagination={false}
          locale={{ emptyText: 'No runs yet' }}
          columns={[
            { title: 'Started', dataIndex: 'started_at', width: 160, render: (v) => fmtDateTime(v) },
            { title: 'Source', dataIndex: 'source_name' },
            { title: 'Trigger', dataIndex: 'trigger', width: 100 },
            {
              title: 'Result',
              key: 'r',
              render: (_, r) =>
                r.status === 'running' ? (
                  <Tag color="processing">running</Tag>
                ) : r.status === 'error' ? (
                  <span style={{ color: '#cf1322' }}>{r.error}</span>
                ) : (
                  `${r.scanned} checked · ${r.found} found · ${r.new_items} new · ${r.updated_assets} updated`
                ),
            },
          ]}
        />
      </div>
      <SourceModal state={editing} plants={(plants.data ?? []).map((p) => ({ value: p.id, label: `${p.code} – ${p.name}` }))} onClose={() => setEditing({ open: false })} />
    </Space>
  );
}

function SourceModal({ state, plants, onClose }: { state: { open: boolean; kind?: DiscoveryKind; source?: DiscoverySource }; plants: { value: string; label: string }[]; onClose: () => void }) {
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const invalidate = useInvalidate();
  const [saving, setSaving] = useState(false);
  const kind = state.kind ?? 'snmp';
  const s = state.source;
  const version = Form.useWatch(['config', 'version'], form);
  const level = Form.useWatch(['config', 'level'], form);
  useEffect(() => {
    if (!state.open) return;
    form.resetFields();
    form.setFieldsValue(
      s
        ? { ...s, secrets: {} }
        : {
            name: '',
            enabled: true,
            schedule_hours: 24,
            config:
              kind === 'snmp'
                ? { targets: '', version: '2c', port: 161, timeoutMs: 1500, retries: 1, level: 'authPriv', authProtocol: 'sha', privProtocol: 'aes' }
                : { url: 'ldaps://', baseDn: '', bindDn: '', serversOnly: true, tlsInsecure: false },
            secrets: {},
          },
    );
  }, [state.open, s, kind, form]);
  const isSet = (k: string) => s?.secrets_set.includes(k as never);
  const secretField = (name: string, label: string) => (
    <Form.Item name={['secrets', name]} label={label} extra={isSet(name) ? 'Stored – leave empty to keep it' : undefined}>
      <Input.Password autoComplete="new-password" placeholder={isSet(name) ? '••••••••' : undefined} />
    </Form.Item>
  );
  return (
    <Modal
      open={state.open}
      title={`${s ? 'Edit' : 'New'} ${DISCOVERY_KIND_META[kind].label}`}
      okText="Save"
      confirmLoading={saving}
      onCancel={onClose}
      width={720}
      destroyOnHidden
      onOk={async () => {
        const v = await form.validateFields();
        setSaving(true);
        try {
          const secrets = Object.fromEntries(Object.entries(v.secrets ?? {}).filter(([, x]) => x));
          const body = { ...v, kind, plant_id: v.plant_id ?? null, secrets };
          if (s) await http.put(`/api/discovery/sources/${s.id}`, body);
          else await http.post('/api/discovery/sources', body);
          message.success('Source saved');
          await invalidate();
          onClose();
        } catch (e) {
          message.error(errorText(e));
        } finally {
          setSaving(false);
        }
      }}
    >
      <Typography.Paragraph type="secondary">{DISCOVERY_KIND_META[kind].description}.</Typography.Paragraph>
      <Form form={form} layout="vertical">
        <Row gutter={12}>
          <Col xs={24} md={12}>
            <Form.Item name="name" label="Name" rules={[{ required: true, whitespace: true }]}>
              <Input placeholder={kind === 'snmp' ? 'e.g. MUC network devices' : 'e.g. example.local'} />
            </Form.Item>
          </Col>
          <Col xs={12} md={6}>
            <Form.Item name="schedule_hours" label="Every (hours)" extra="0 = manual only">
              <InputNumber min={0} max={720} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col xs={12} md={6}>
            <Form.Item name="enabled" label="Active" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Col>
          <Col span={24}>
            <Form.Item name="plant_id" label="Plant for new devices">
              <Select allowClear options={plants} placeholder="–" />
            </Form.Item>
          </Col>
          {kind === 'snmp' ? (
            <>
              <Col span={24}>
                <Form.Item
                  name={['config', 'targets']}
                  label="Addresses"
                  rules={[{ required: true, whitespace: true }]}
                  extra="Networks, ranges and single addresses, e.g. 10.10.0.0/24, 10.10.1.1-10.10.1.50, 10.10.2.5 (max. 4096 addresses)"
                >
                  <Input.TextArea className="mono" autoSize={{ minRows: 2, maxRows: 5 }} />
                </Form.Item>
              </Col>
              <Col xs={12} md={6}>
                <Form.Item name={['config', 'version']} label="SNMP version">
                  <Select options={[{ value: '2c', label: 'v2c' }, { value: '3', label: 'v3' }]} />
                </Form.Item>
              </Col>
              <Col xs={12} md={6}>
                <Form.Item name={['config', 'port']} label="Port">
                  <InputNumber min={1} max={65535} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col xs={12} md={6}>
                <Form.Item name={['config', 'timeoutMs']} label="Timeout (ms)">
                  <InputNumber min={200} max={20000} step={100} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col xs={12} md={6}>
                <Form.Item name={['config', 'retries']} label="Retries">
                  <InputNumber min={0} max={5} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              {version === '3' ? (
                <>
                  <Col xs={24} md={8}>
                    <Form.Item name={['config', 'user']} label="User" rules={[{ required: true }]}>
                      <Input />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={16}>
                    <Form.Item name={['config', 'level']} label="Security level">
                      <Select options={SNMP_LEVELS.map((l) => ({ value: l, label: l }))} />
                    </Form.Item>
                  </Col>
                  {level !== 'noAuthNoPriv' && (
                    <>
                      <Col xs={12} md={8}>
                        <Form.Item name={['config', 'authProtocol']} label="Authentication">
                          <Select options={SNMP_AUTH_PROTOCOLS.map((p) => ({ value: p, label: p.toUpperCase() }))} />
                        </Form.Item>
                      </Col>
                      <Col xs={12} md={16}>
                        {secretField('authKey', 'Authentication password')}
                      </Col>
                    </>
                  )}
                  {level === 'authPriv' && (
                    <>
                      <Col xs={12} md={8}>
                        <Form.Item name={['config', 'privProtocol']} label="Encryption">
                          <Select options={SNMP_PRIV_PROTOCOLS.map((p) => ({ value: p, label: p.toUpperCase() }))} />
                        </Form.Item>
                      </Col>
                      <Col xs={12} md={16}>
                        {secretField('privKey', 'Encryption password')}
                      </Col>
                    </>
                  )}
                </>
              ) : (
                <Col span={24}>{secretField('community', 'Community (read-only)')}</Col>
              )}
            </>
          ) : (
            <>
              <Col span={24}>
                <Form.Item name={['config', 'url']} label="Domain controller" rules={[{ required: true }]} extra="ldaps://dc01.example.local:636 – LDAPS is strongly recommended">
                  <Input className="mono" />
                </Form.Item>
              </Col>
              <Col span={24}>
                <Form.Item name={['config', 'baseDn']} label="Search base" rules={[{ required: true }]}>
                  <Input className="mono" placeholder="DC=example,DC=local" />
                </Form.Item>
              </Col>
              <Col xs={24} md={14}>
                <Form.Item name={['config', 'bindDn']} label="Service account (DN or user@domain)" rules={[{ required: true }]}>
                  <Input className="mono" placeholder="svc-cmdb@example.local" />
                </Form.Item>
              </Col>
              <Col xs={24} md={10}>
                {secretField('bindPassword', 'Password')}
              </Col>
              <Col xs={12}>
                <Form.Item name={['config', 'serversOnly']} label="Only servers" valuePropName="checked">
                  <Switch />
                </Form.Item>
              </Col>
              <Col xs={12}>
                <Form.Item name={['config', 'tlsInsecure']} label="Skip certificate check" valuePropName="checked" extra="Only for tests">
                  <Switch />
                </Form.Item>
              </Col>
            </>
          )}
        </Row>
      </Form>
    </Modal>
  );
}

