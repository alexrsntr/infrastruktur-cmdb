import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, App, Button, Card, Col, Drawer, Form, Input, InputNumber, Modal, Popconfirm, Row, Select, Space, Switch, Table, Tag, Tooltip, Typography } from 'antd';
import { ApiOutlined, DeleteOutlined, EditOutlined, KeyOutlined, PlusOutlined, ReloadOutlined, SendOutlined } from '@ant-design/icons';
import { WEBHOOK_EVENT_GROUPS, type ApiTokenCreated, type ApiTokenDto, type WebhookDelivery, type WebhookDto } from '../../../../shared/integrations';
import { ROLES, ROLE_META } from '../../../../shared/model';
import { errorText, http } from '../../lib/api';
import { fmtDateTime, fromNow } from '../../lib/format';
import { usePlants } from '../../lib/queries';

/** API tokens for scripts and other systems, and webhooks that report changes to other systems. */
export function IntegrationsTab() {
  return (
    <Space direction="vertical" size={20} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="Connect other systems"
        description={
          <span>
            Scripts and tools (monitoring, ticket system, inventory scanners) use an API token: <span className="mono">Authorization: Bearer cmdb_…</span>. Webhooks send every
            change as a signed JSON request. The API is described in <span className="mono">docs/API.md</span>.
          </span>
        }
      />
      <TokensCard />
      <WebhooksCard />
    </Space>
  );
}

function TokensCard() {
  const { message } = App.useApp();
  const plants = usePlants();
  const tokens = useQuery({ queryKey: ['api-tokens'], queryFn: () => http.get<ApiTokenDto[]>('/api/settings/api-tokens') });
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<ApiTokenCreated | null>(null);
  const [form] = Form.useForm();
  const role = Form.useWatch('role', form);

  const revoke = async (t: ApiTokenDto) => {
    try {
      await http.del(`/api/settings/api-tokens/${t.id}`);
      message.success(`Token "${t.name}" revoked`);
      await tokens.refetch();
    } catch (e) {
      message.error(errorText(e));
    }
  };

  return (
    <Card
      title={
        <Space>
          <KeyOutlined /> API tokens
        </Space>
      }
      extra={
        <Button icon={<PlusOutlined />} onClick={() => setCreating(true)}>
          New token
        </Button>
      }
    >
      <Table<ApiTokenDto>
        rowKey="id"
        size="middle"
        loading={tokens.isLoading}
        dataSource={tokens.data ?? []}
        pagination={false}
        locale={{ emptyText: 'No API tokens yet' }}
        columns={[
          {
            title: 'Name',
            key: 'name',
            render: (_, t) => (
              <div style={{ opacity: t.revoked_at ? 0.55 : 1 }}>
                <Typography.Text strong>{t.name}</Typography.Text>
                <div className="muted mono" style={{ fontSize: 12 }}>
                  {t.token_prefix}…
                </div>
              </div>
            ),
          },
          { title: 'Role', key: 'role', width: 130, render: (_, t) => <Tag color={ROLE_META[t.role].color}>{ROLE_META[t.role].label}</Tag> },
          {
            title: 'Plants',
            key: 'scope',
            width: 160,
            render: (_, t) =>
              t.plant_scope.length ? (plants.data ?? []).filter((p) => t.plant_scope.includes(p.id)).map((p) => p.code).join(', ') : <span className="muted">All</span>,
          },
          {
            title: 'Last used',
            key: 'used',
            width: 170,
            render: (_, t) => (t.last_used_at ? <Tooltip title={`${fmtDateTime(t.last_used_at)} · ${t.last_used_ip ?? ''}`}>{fromNow(t.last_used_at)}</Tooltip> : <span className="muted">never</span>),
          },
          {
            title: 'State',
            key: 'state',
            width: 170,
            render: (_, t) =>
              t.revoked_at ? (
                <Tag>Revoked</Tag>
              ) : t.expires_at && new Date(t.expires_at) < new Date() ? (
                <Tag color="red">Expired</Tag>
              ) : (
                <span>
                  <Tag color="green">Active</Tag>
                  {t.expires_at && <span className="muted" style={{ fontSize: 12 }}>until {fmtDateTime(t.expires_at).slice(0, 10)}</span>}
                </span>
              ),
          },
          {
            title: '',
            key: 'x',
            width: 60,
            render: (_, t) =>
              !t.revoked_at && (
                <Popconfirm title={`Revoke "${t.name}"?`} description="Scripts using it stop working immediately." onConfirm={() => revoke(t)}>
                  <Button type="text" danger icon={<DeleteOutlined />} aria-label={`Revoke ${t.name}`} />
                </Popconfirm>
              ),
          },
        ]}
      />
      <Modal
        open={creating}
        title="New API token"
        okText="Create token"
        onCancel={() => setCreating(false)}
        destroyOnHidden
        onOk={async () => {
          const v = await form.validateFields();
          try {
            const t = await http.post<ApiTokenCreated>('/api/settings/api-tokens', { ...v, plant_scope: v.plant_scope ?? [], expires_in_days: v.expires_in_days ?? null });
            setCreating(false);
            setCreated(t);
            form.resetFields();
            await tokens.refetch();
          } catch (e) {
            message.error(errorText(e));
          }
        }}
      >
        <Form form={form} layout="vertical" initialValues={{ role: 'viewer', expires_in_days: 365 }}>
          <Form.Item name="name" label="Name" rules={[{ required: true, whitespace: true }]} extra="Shown as the author of changes, e.g. “Zabbix” or “Inventory script”.">
            <Input autoFocus />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="role" label="Permissions">
                <Select options={ROLES.map((r) => ({ value: r, label: ROLE_META[r].label }))} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="expires_in_days" label="Valid for (days)" extra="Empty = no expiry">
                <InputNumber min={1} max={3650} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          {role !== 'admin' && (
            <Form.Item name="plant_scope" label="Plants" extra="Empty = all plants">
              <Select mode="multiple" allowClear placeholder="All plants" options={(plants.data ?? []).map((p) => ({ value: p.id, label: `${p.code} – ${p.name}` }))} />
            </Form.Item>
          )}
          <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
            {ROLE_META[(role ?? 'viewer') as keyof typeof ROLE_META].description}
          </Typography.Text>
        </Form>
      </Modal>
      <Modal open={!!created} title="Copy the token now" onCancel={() => setCreated(null)} footer={<Button type="primary" onClick={() => setCreated(null)}>Done</Button>}>
        <Alert type="warning" showIcon message="The token is shown only once. Store it in your password manager or the secret store of the calling system." style={{ marginBottom: 12 }} />
        <Typography.Paragraph copyable className="mono" style={{ wordBreak: 'break-all', background: 'var(--cmdb-surface-2, #f5f5f5)', padding: 10, borderRadius: 6 }}>
          {created?.token}
        </Typography.Paragraph>
        <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
          Example: <span className="mono">curl -H "Authorization: Bearer {created?.token_prefix}…" {window.location.origin}/api/assets</span>
        </Typography.Text>
      </Modal>
    </Card>
  );
}

function WebhooksCard() {
  const { message, modal } = App.useApp();
  const hooks = useQuery({ queryKey: ['webhooks'], queryFn: () => http.get<WebhookDto[]>('/api/settings/webhooks'), refetchInterval: 15000 });
  const [editing, setEditing] = useState<{ open: boolean; hook?: WebhookDto }>({ open: false });
  const [log, setLog] = useState<WebhookDto | null>(null);

  const showSecret = (secret: string) =>
    modal.info({
      title: 'Signing secret',
      width: 560,
      content: (
        <div>
          <Typography.Paragraph>Shown only once. Check the X-CMDB-Signature header with it (HMAC-SHA256 of “timestamp.body”).</Typography.Paragraph>
          <Typography.Paragraph copyable className="mono" style={{ wordBreak: 'break-all' }}>
            {secret}
          </Typography.Paragraph>
        </div>
      ),
    });

  const test = async (h: WebhookDto) => {
    try {
      const r = await http.post<{ ok: boolean; status: number; error: string | null }>(`/api/settings/webhooks/${h.id}/test`);
      if (r.ok) message.success(`${h.name}: answered with HTTP ${r.status}`);
      else message.error(`${h.name}: ${r.error}`);
      await hooks.refetch();
    } catch (e) {
      message.error(errorText(e));
    }
  };
  const remove = async (h: WebhookDto) => {
    try {
      await http.del(`/api/settings/webhooks/${h.id}`);
      await hooks.refetch();
    } catch (e) {
      message.error(errorText(e));
    }
  };
  const rotate = async (h: WebhookDto) => {
    try {
      const r = await http.post<{ secret: string }>(`/api/settings/webhooks/${h.id}/secret`);
      showSecret(r.secret);
    } catch (e) {
      message.error(errorText(e));
    }
  };

  return (
    <Card
      title={
        <Space>
          <ApiOutlined /> Webhooks
        </Space>
      }
      extra={
        <Button icon={<PlusOutlined />} onClick={() => setEditing({ open: true })}>
          New webhook
        </Button>
      }
    >
      <Table<WebhookDto>
        rowKey="id"
        size="middle"
        loading={hooks.isLoading}
        dataSource={hooks.data ?? []}
        pagination={false}
        locale={{ emptyText: 'No webhooks yet' }}
        columns={[
          {
            title: 'Webhook',
            key: 'name',
            render: (_, h) => (
              <div style={{ opacity: h.active ? 1 : 0.55 }}>
                <Typography.Text strong>{h.name}</Typography.Text>
                <div className="muted mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>
                  {h.url}
                </div>
              </div>
            ),
          },
          { title: 'Events', key: 'events', render: (_, h) => h.events.map((e) => <Tag key={e}>{e}</Tag>) },
          {
            title: 'Last delivery',
            key: 'last',
            width: 220,
            render: (_, h) => (
              <div>
                {h.last_delivery_at ? (
                  <>
                    <span style={{ color: h.last_status?.startsWith('HTTP 2') ? undefined : '#cf1322' }}>{h.last_status}</span>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {fromNow(h.last_delivery_at)}
                    </div>
                  </>
                ) : (
                  <span className="muted">–</span>
                )}
                {h.pending > 0 && <Tag color="blue">{h.pending} pending</Tag>}
                {h.failed > 0 && <Tag color="red">{h.failed} failed</Tag>}
              </div>
            ),
          },
          {
            title: '',
            key: 'x',
            width: 170,
            render: (_, h) => (
              <Space size={0}>
                <Tooltip title="Send test">
                  <Button type="text" icon={<SendOutlined />} aria-label={`Test ${h.name}`} onClick={() => test(h)} />
                </Tooltip>
                <Tooltip title="Deliveries">
                  <Button type="text" icon={<ReloadOutlined />} aria-label={`Deliveries of ${h.name}`} onClick={() => setLog(h)} />
                </Tooltip>
                <Tooltip title="Edit">
                  <Button type="text" icon={<EditOutlined />} aria-label={`Edit ${h.name}`} onClick={() => setEditing({ open: true, hook: h })} />
                </Tooltip>
                <Popconfirm title="New signing secret?" description="The receiver must be updated." onConfirm={() => rotate(h)}>
                  <Tooltip title="New secret">
                    <Button type="text" icon={<KeyOutlined />} aria-label={`New secret for ${h.name}`} />
                  </Tooltip>
                </Popconfirm>
                <Popconfirm title={`Delete ${h.name}?`} onConfirm={() => remove(h)}>
                  <Button type="text" danger icon={<DeleteOutlined />} aria-label={`Delete ${h.name}`} />
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <WebhookModal state={editing} onClose={() => setEditing({ open: false })} onSaved={async (secret) => {
        await hooks.refetch();
        if (secret) showSecret(secret);
      }} />
      <DeliveriesDrawer hook={log} onClose={() => setLog(null)} />
    </Card>
  );
}

function WebhookModal({ state, onClose, onSaved }: { state: { open: boolean; hook?: WebhookDto }; onClose: () => void; onSaved: (secret?: string) => void }) {
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const h = state.hook;
  useEffect(() => {
    if (state.open) form.setFieldsValue(h ? { ...h } : { name: '', url: '', events: ['*'], active: true });
  }, [state.open, h, form]);
  return (
    <Modal
      open={state.open}
      title={h ? `Edit ${h.name}` : 'New webhook'}
      okText="Save"
      onCancel={onClose}
      destroyOnHidden
      width={620}
      onOk={async () => {
        const v = await form.validateFields();
        try {
          if (h) {
            await http.put(`/api/settings/webhooks/${h.id}`, v);
            onSaved();
          } else {
            const created = await http.post<WebhookDto & { secret: string }>('/api/settings/webhooks', v);
            onSaved(created.secret);
          }
          onClose();
        } catch (e) {
          message.error(errorText(e));
        }
      }}
    >
      <Form form={form} layout="vertical">
        <Form.Item name="name" label="Name" rules={[{ required: true, whitespace: true }]}>
          <Input placeholder="e.g. ServiceNow, Teams channel" />
        </Form.Item>
        <Form.Item name="url" label="URL" rules={[{ required: true }, { pattern: /^https?:\/\//i, message: 'Start with https://' }]}>
          <Input className="mono" placeholder="https://" />
        </Form.Item>
        <Form.Item name="events" label="Events" rules={[{ required: true, type: 'array', min: 1 }]}>
          <Select mode="tags" options={WEBHOOK_EVENT_GROUPS.map((g) => ({ value: g.value, label: `${g.value} – ${g.label}` }))} />
        </Form.Item>
        <Form.Item name="active" label="Active" valuePropName="checked">
          <Switch />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function DeliveriesDrawer({ hook, onClose }: { hook: WebhookDto | null; onClose: () => void }) {
  const { message } = App.useApp();
  const q = useQuery({ queryKey: ['webhook-deliveries', hook?.id], queryFn: () => http.get<WebhookDelivery[]>(`/api/settings/webhooks/${hook!.id}/deliveries`), enabled: !!hook });
  return (
    <Drawer open={!!hook} onClose={onClose} width={720} title={hook ? `Deliveries – ${hook.name}` : ''}>
      <Table<WebhookDelivery>
        rowKey="id"
        size="small"
        dataSource={q.data ?? []}
        loading={q.isLoading}
        pagination={false}
        columns={[
          { title: 'Event', dataIndex: 'event', render: (v) => <span className="mono">{v}</span> },
          { title: 'Created', dataIndex: 'created_at', width: 150, render: (v) => fmtDateTime(v) },
          {
            title: 'Result',
            key: 'r',
            render: (_, d) => (
              <div>
                <Tag color={d.status === 'ok' ? 'green' : d.status === 'failed' ? 'red' : 'blue'}>{d.status}</Tag>
                <span className="muted" style={{ fontSize: 12 }}>
                  {d.attempts} attempt{d.attempts === 1 ? '' : 's'}
                </span>
                {d.last_error && <div style={{ fontSize: 12, color: '#cf1322' }}>{d.last_error}</div>}
                {d.status === 'pending' && d.attempts > 0 && <div className="muted" style={{ fontSize: 12 }}>next try {fromNow(d.next_attempt_at)}</div>}
              </div>
            ),
          },
          {
            title: '',
            key: 'x',
            width: 80,
            render: (_, d) =>
              d.status === 'failed' && (
                <Button
                  size="small"
                  onClick={async () => {
                    try {
                      await http.post(`/api/settings/webhooks/${hook!.id}/deliveries/${d.id}/retry`);
                      await q.refetch();
                    } catch (e) {
                      message.error(errorText(e));
                    }
                  }}
                >
                  Retry
                </Button>
              ),
          },
        ]}
      />
    </Drawer>
  );
}
