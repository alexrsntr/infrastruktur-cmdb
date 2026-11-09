import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { App, Button, Col, Empty, Form, Input, Modal, Popconfirm, Row, Select, Space, Switch, Table, Tag, Tooltip, Typography } from 'antd';
import { ApiOutlined, DeleteOutlined, DisconnectOutlined, EditOutlined, LinkOutlined, PlusOutlined } from '@ant-design/icons';
import { PORT_KINDS, PORT_KIND_META, type AssetPort } from '../../../shared/network';
import type { AssetType } from '../../../shared/model';
import { errorText, http } from '../lib/api';
import { useInvalidate } from '../lib/queries';
import { useSession } from '../lib/session';
import { TypeIcon } from './Simple';

export const usePorts = (assetId: string) => useQuery({ queryKey: ['ports', assetId], queryFn: () => http.get<AssetPort[]>(`/api/assets/${assetId}/ports`) });

const vlanText = (p: AssetPort) => {
  const parts: string[] = [];
  if (p.untagged_vlan) parts.push(`${p.untagged_vlan}${p.mode === 'trunk' ? ' (native)' : ''}`);
  if (p.tagged_vlans.length) parts.push(`tagged ${p.tagged_vlans.join(', ')}`);
  return parts.join(' · ');
};

/** Ports of a device with the cable to the far end (switch port ⇄ device port), VLANs and cable labels. */
export function PortsPanel({ assetId, assetName }: { assetId: string; assetName: string }) {
  const { can } = useSession();
  const { message } = App.useApp();
  const invalidate = useInvalidate();
  const ports = usePorts(assetId);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AssetPort | null>(null);
  const [connecting, setConnecting] = useState<AssetPort | null>(null);
  const writable = can('asset.write');

  const disconnect = async (p: AssetPort) => {
    try {
      await http.post(`/api/ports/${p.id}/disconnect`);
      message.success(`Cable on ${p.name} removed`);
      await invalidate();
    } catch (e) {
      message.error(errorText(e));
    }
  };
  const remove = async (p: AssetPort) => {
    try {
      await http.del(`/api/ports/${p.id}`);
      message.success(`Port ${p.name} deleted`);
      await invalidate();
    } catch (e) {
      message.error(errorText(e));
    }
  };

  const list = ports.data ?? [];
  const connected = list.filter((p) => p.connected_port_id).length;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <Typography.Text type="secondary">
          {list.length ? `${list.length} ports · ${connected} connected` : 'No ports documented yet.'}
        </Typography.Text>
        <div style={{ flex: 1 }} />
        {writable && (
          <Button icon={<PlusOutlined />} onClick={() => setAdding(true)}>
            Add ports
          </Button>
        )}
      </div>
      {list.length === 0 && !ports.isLoading ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Document the ports to see which cable goes where." />
      ) : (
        <Table<AssetPort>
          rowKey="id"
          size="small"
          loading={ports.isLoading}
          dataSource={list}
          pagination={list.length > 60 ? { pageSize: 60, showSizeChanger: false } : false}
          scroll={{ x: 640 }}
          columns={[
            {
              title: 'Port',
              key: 'name',
              width: 130,
              render: (_, p) => (
                <span>
                  <span className="mono" style={{ fontWeight: 600, opacity: p.enabled ? 1 : 0.5 }}>
                    {p.name}
                  </span>
                  {p.speed && <div className="muted" style={{ fontSize: 12 }}>{p.speed}</div>}
                </span>
              ),
            },
            {
              title: 'Connected to',
              key: 'peer',
              render: (_, p) =>
                p.peer_asset_name ? (
                  <Space size={8}>
                    {p.peer_asset_type && <TypeIcon type={p.peer_asset_type as AssetType} />}
                    <span>
                      {p.peer_asset_id ? <Link to={`/assets/${p.peer_asset_id}?tab=ports`}>{p.peer_asset_name}</Link> : p.peer_asset_name}
                      {p.peer_port_name && <span className="mono muted"> · {p.peer_port_name}</span>}
                    </span>
                  </Space>
                ) : (
                  <span className="muted">{p.description || '–'}</span>
                ),
            },
            { title: 'Cable', key: 'cable', width: 120, render: (_, p) => (p.cable_label ? <Tag>{p.cable_label}</Tag> : <span className="muted">–</span>) },
            { title: 'VLAN', key: 'vlan', width: 150, render: (_, p) => vlanText(p) || <span className="muted">–</span> },
            ...(writable
              ? [
                  {
                    title: '',
                    key: 'actions',
                    width: 120,
                    align: 'right' as const,
                    render: (_: unknown, p: AssetPort) => (
                      <Space size={0}>
                        <Tooltip title={p.connected_port_id ? 'Change cable' : 'Connect cable'}>
                          <Button type="text" size="small" icon={<LinkOutlined />} aria-label={`Connect ${p.name}`} onClick={() => setConnecting(p)} />
                        </Tooltip>
                        {p.connected_port_id && (
                          <Popconfirm title={`Remove the cable on ${p.name}?`} onConfirm={() => disconnect(p)}>
                            <Tooltip title="Remove cable">
                              <Button type="text" size="small" icon={<DisconnectOutlined />} aria-label={`Disconnect ${p.name}`} />
                            </Tooltip>
                          </Popconfirm>
                        )}
                        <Tooltip title="Edit port">
                          <Button type="text" size="small" icon={<EditOutlined />} aria-label={`Edit ${p.name}`} onClick={() => setEditing(p)} />
                        </Tooltip>
                        <Popconfirm title={`Delete port ${p.name}?`} onConfirm={() => remove(p)}>
                          <Button type="text" size="small" danger icon={<DeleteOutlined />} aria-label={`Delete ${p.name}`} />
                        </Popconfirm>
                      </Space>
                    ),
                  },
                ]
              : []),
          ]}
        />
      )}
      <AddPortsModal open={adding} assetId={assetId} onClose={() => setAdding(false)} />
      <PortModal port={editing} onClose={() => setEditing(null)} />
      <ConnectModal port={connecting} assetName={assetName} onClose={() => setConnecting(null)} />
    </div>
  );
}

const toVlans = (v: unknown): number[] =>
  Array.isArray(v)
    ? [...new Set(v.flatMap((x) => String(x).split(/[,\s;]+/)).map((x) => Number(x)).filter((n) => Number.isInteger(n) && n >= 1 && n <= 4094))]
    : [];
const toVlan = (v: unknown): number | null => {
  const n = Number(Array.isArray(v) ? v[0] : v);
  return Number.isInteger(n) && n >= 1 && n <= 4094 ? n : null;
};

function AddPortsModal({ open, assetId, onClose }: { open: boolean; assetId: string; onClose: () => void }) {
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const invalidate = useInvalidate();
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) form.setFieldsValue({ names: '', kind: 'ethernet', speed: undefined });
  }, [open, form]);
  return (
    <Modal
      open={open}
      title="Add ports"
      okText="Add"
      confirmLoading={saving}
      onCancel={onClose}
      destroyOnHidden
      onOk={async () => {
        const v = await form.validateFields();
        setSaving(true);
        try {
          const created = await http.post<AssetPort[]>(`/api/assets/${assetId}/ports`, { names: v.names, kind: v.kind, speed: v.speed || null });
          message.success(`${created.length} ports on this device`);
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
        <Form.Item
          name="names"
          label="Port names"
          rules={[{ required: true, whitespace: true, message: 'Enter at least one port' }]}
          extra="Ranges are expanded: “Gi1/0/1-48, Te1/1/1-4” creates 52 ports."
        >
          <Input className="mono" placeholder="Gi1/0/1-48" autoFocus />
        </Form.Item>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="kind" label="Kind">
              <Select options={PORT_KINDS.map((k) => ({ value: k, label: PORT_KIND_META[k].label }))} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="speed" label="Speed">
              <Input placeholder="e.g. 1G, 10G" />
            </Form.Item>
          </Col>
        </Row>
      </Form>
    </Modal>
  );
}

function PortModal({ port, onClose }: { port: AssetPort | null; onClose: () => void }) {
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const invalidate = useInvalidate();
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (port) form.setFieldsValue({ ...port, untagged_vlan: port.untagged_vlan ?? undefined, tagged_vlans: port.tagged_vlans.map(String) });
  }, [port, form]);
  return (
    <Modal
      open={!!port}
      title={port ? `Port ${port.name}` : ''}
      okText="Save"
      confirmLoading={saving}
      onCancel={onClose}
      width={640}
      destroyOnHidden
      onOk={async () => {
        const v = await form.validateFields();
        setSaving(true);
        try {
          await http.put(`/api/ports/${port!.id}`, {
            name: v.name,
            kind: v.kind,
            speed: v.speed || null,
            description: v.description || null,
            enabled: v.enabled,
            mode: v.mode || null,
            untagged_vlan: toVlan(v.untagged_vlan),
            tagged_vlans: toVlans(v.tagged_vlans),
            mac_address: v.mac_address || null,
            cable_label: v.cable_label || null,
          });
          message.success('Port saved');
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
          <Col xs={12} md={8}>
            <Form.Item name="name" label="Name" rules={[{ required: true, whitespace: true, max: 64 }]}>
              <Input className="mono" />
            </Form.Item>
          </Col>
          <Col xs={12} md={8}>
            <Form.Item name="kind" label="Kind">
              <Select options={PORT_KINDS.map((k) => ({ value: k, label: PORT_KIND_META[k].label }))} />
            </Form.Item>
          </Col>
          <Col xs={12} md={4}>
            <Form.Item name="speed" label="Speed">
              <Input />
            </Form.Item>
          </Col>
          <Col xs={12} md={4}>
            <Form.Item name="enabled" label="Enabled" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Col>
          <Col xs={12} md={8}>
            <Form.Item name="mode" label="Mode">
              <Select allowClear placeholder="–" options={[{ value: 'access', label: 'Access' }, { value: 'trunk', label: 'Trunk' }]} />
            </Form.Item>
          </Col>
          <Col xs={12} md={8}>
            <Form.Item name="untagged_vlan" label="Untagged / native VLAN" rules={[{ validator: (_, v) => (v === undefined || v === null || v === '' || toVlan(v) ? Promise.resolve() : Promise.reject(new Error('1–4094'))) }]}>
              <Input inputMode="numeric" placeholder="e.g. 10" />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="tagged_vlans" label="Tagged VLANs">
              <Select mode="tags" tokenSeparators={[',', ' ', ';']} placeholder="e.g. 10, 20, 100" open={false} />
            </Form.Item>
          </Col>
          <Col xs={12}>
            <Form.Item name="cable_label" label="Cable label" extra={port?.connected_port_id ? 'Also changed on the other end of the cable' : undefined}>
              <Input />
            </Form.Item>
          </Col>
          <Col xs={12}>
            <Form.Item name="mac_address" label="MAC address">
              <Input className="mono" />
            </Form.Item>
          </Col>
          <Col span={24}>
            <Form.Item name="description" label="Description">
              <Input placeholder="e.g. Printer office 1.12" />
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

function ConnectModal({ port, assetName, onClose }: { port: AssetPort | null; assetName: string; onClose: () => void }) {
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const invalidate = useInvalidate();
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const peerAsset = Form.useWatch('asset_id', form) as string | undefined;
  const options = useQuery({
    queryKey: ['asset-options', search],
    queryFn: () => http.get<AssetOption[]>('/api/assets/options', { q: search || undefined }),
    enabled: !!port,
  });
  const peerPorts = useQuery({
    queryKey: ['ports', peerAsset ?? ''],
    queryFn: () => http.get<AssetPort[]>(`/api/assets/${peerAsset}/ports`),
    enabled: !!peerAsset,
  });
  useEffect(() => {
    if (port) form.setFieldsValue({ asset_id: port.peer_asset_id ?? undefined, port_id: port.connected_port_id ?? undefined, cable_label: port.cable_label ?? '' });
  }, [port, form]);

  return (
    <Modal
      open={!!port}
      title={port ? `Cable from ${assetName} · ${port.name}` : ''}
      okText="Connect"
      okButtonProps={{ icon: <ApiOutlined /> }}
      confirmLoading={saving}
      onCancel={onClose}
      destroyOnHidden
      onOk={async () => {
        const v = await form.validateFields();
        setSaving(true);
        try {
          await http.post(`/api/ports/${port!.id}/connect`, { port_id: v.port_id, cable_label: v.cable_label || null });
          message.success('Cable documented');
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
        <Form.Item name="asset_id" label="Other device" rules={[{ required: true, message: 'Choose the device at the other end' }]}>
          <Select
            showSearch
            filterOption={false}
            onSearch={setSearch}
            placeholder="Search by name or IP"
            loading={options.isFetching}
            onChange={() => form.setFieldValue('port_id', undefined)}
            options={(options.data ?? [])
              .filter((o) => o.id !== port?.asset_id)
              .map((o) => ({ value: o.id, label: `${o.name}${o.plant_code ? ` · ${o.plant_code}` : ''}` }))}
          />
        </Form.Item>
        <Form.Item
          name="port_id"
          label="Port on the other device"
          rules={[{ required: true, message: 'Choose the port' }]}
          extra={peerAsset && peerPorts.data && !peerPorts.data.length ? 'This device has no ports yet – add them on its device page first.' : undefined}
        >
          <Select
            showSearch
            optionFilterProp="label"
            disabled={!peerAsset}
            loading={peerPorts.isFetching}
            options={(peerPorts.data ?? []).map((p) => ({
              value: p.id,
              label: `${p.name}${p.peer_asset_name && p.connected_port_id !== port?.id ? ` (in use: ${p.peer_asset_name})` : ''}`,
            }))}
          />
        </Form.Item>
        <Form.Item name="cable_label" label="Cable label">
          <Input placeholder="e.g. K-0815" />
        </Form.Item>
        <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
          An existing cable on either port is replaced.
        </Typography.Text>
      </Form>
    </Modal>
  );
}

