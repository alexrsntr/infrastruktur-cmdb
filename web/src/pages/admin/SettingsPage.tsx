import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Divider,
  Empty,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Result,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { CheckCircleOutlined, EyeOutlined, MailOutlined, SaveOutlined, SendOutlined } from '@ant-design/icons';
import { ASSET_STATUSES, ASSET_STATUS_META, type Plant } from '../../../../shared/model';
import {
  SMTP_SECURITY,
  SMTP_SECURITY_META,
  type EmailSettingsDto,
  type EmailSettingsInput,
  type NotificationLogEntry,
  type NotificationRun,
  type NotificationSettingsDto,
  type RunResult,
  type SmtpSecurity,
  type WarrantyNotificationSettings,
  type WarrantyPreview,
} from '../../../../shared/notifications';
import { errorText, http } from '../../lib/api';
import { fmtDate, fmtDateTime, fromNow } from '../../lib/format';
import { usePlants } from '../../lib/queries';
import { useSession } from '../../lib/session';
import { PageHeader } from '../../components/PageHeader';
import { EntraSettingsTab } from './EntraSettingsTab';
import { AssetTypeTag, WarrantyDate } from '../../components/Tags';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const FALLBACK_TIMEZONES = ['UTC', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney'];

/** All IANA time zones the browser knows (falls back to a short list in very old browsers). */
const TIMEZONES: string[] = (() => {
  try {
    return ['UTC', ...Intl.supportedValuesOf('timeZone').filter((z) => z !== 'UTC')];
  } catch {
    return FALLBACK_TIMEZONES;
  }
})();

const RUN_STATUS: Record<NotificationRun['status'], { color: string; label: string }> = {
  ok: { color: 'success', label: 'Sent' },
  error: { color: 'error', label: 'Failed' },
  skipped: { color: 'default', label: 'Skipped' },
  running: { color: 'processing', label: 'Running' },
};

const thresholdLabel = (t: number) => (t === 0 ? 'expired' : `${t} days`);

function emailRule() {
  return {
    validator: (_: unknown, value: string[] | undefined) => {
      const bad = (value ?? []).filter((v) => !EMAIL_RE.test(v));
      return bad.length ? Promise.reject(new Error(`Invalid e-mail address: ${bad.join(', ')}`)) : Promise.resolve();
    },
  };
}

// ---------------------------------------------------------------------------
// SMTP
// ---------------------------------------------------------------------------

type SmtpForm = Omit<EmailSettingsInput, 'password'> & { password?: string };

function SmtpTab() {
  const { me } = useSession();
  const { message } = App.useApp();
  const [form] = Form.useForm<SmtpForm>();
  const [saving, setSaving] = useState(false);
  const [testTo, setTestTo] = useState(me.user.email ?? '');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const settings = useQuery({ queryKey: ['settings', 'email'], queryFn: () => http.get<EmailSettingsDto>('/api/settings/email') });
  const username = Form.useWatch('username', form);

  useEffect(() => {
    if (!settings.data) return;
    const { passwordSet: _p, passwordUnreadable: _u, configured: _c, updatedAt: _t, ...rest } = settings.data;
    form.setFieldsValue({ ...rest, password: '' });
  }, [settings.data, form]);

  const save = async (patch?: Partial<EmailSettingsInput>) => {
    const values = await form.validateFields();
    const body: EmailSettingsInput = { ...values, password: values.password ? values.password : undefined, ...patch };
    setSaving(true);
    try {
      await http.put('/api/settings/email', body);
      message.success('E-mail settings saved');
      form.setFieldValue('password', '');
      await settings.refetch();
    } catch (e) {
      message.error(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await http.post<{ ok: boolean; message: string }>('/api/settings/email/test', { to: testTo });
      setTestResult({ ok: true, text: res.message });
    } catch (e) {
      setTestResult({ ok: false, text: errorText(e) });
    } finally {
      setTesting(false);
    }
  };

  const s = settings.data;
  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} xl={15}>
        <Card
          title="E-mail server (SMTP)"
          loading={settings.isLoading}
          extra={s?.configured ? <Tag color="success" icon={<CheckCircleOutlined />}>Configured</Tag> : <Tag>Not configured</Tag>}
        >
          <Form form={form} layout="vertical" disabled={saving}>
            <Row gutter={16}>
              <Col xs={24} md={12}>
                <Form.Item name="host" label="SMTP server" rules={[{ required: true, message: 'Enter the SMTP server' }]}>
                  <Input placeholder="smtp-relay.example.local" />
                </Form.Item>
              </Col>
              <Col xs={12} md={6}>
                <Form.Item name="security" label="Encryption" rules={[{ required: true }]}>
                  <Select
                    options={SMTP_SECURITY.map((k) => ({ value: k, label: SMTP_SECURITY_META[k].label }))}
                    onChange={(v: SmtpSecurity) => form.setFieldValue('port', SMTP_SECURITY_META[v].port)}
                  />
                </Form.Item>
              </Col>
              <Col xs={12} md={6}>
                <Form.Item name="port" label="Port" rules={[{ required: true }]}>
                  <InputNumber min={1} max={65535} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col xs={24} md={12}>
                <Form.Item name="username" label="Username" extra="Leave empty if the relay does not require authentication.">
                  <Input autoComplete="off" />
                </Form.Item>
              </Col>
              <Col xs={24} md={12}>
                <Form.Item
                  name="password"
                  label="Password"
                  extra={
                    s?.passwordUnreadable ? (
                      <Typography.Text type="danger">The stored password can no longer be decrypted – please enter it again.</Typography.Text>
                    ) : s?.passwordSet ? (
                      <span>
                        A password is stored (encrypted). Leave empty to keep it.{' '}
                        <Popconfirm title="Remove the stored password?" onConfirm={() => save({ password: null })}>
                          <Typography.Link>Remove stored password</Typography.Link>
                        </Popconfirm>
                      </span>
                    ) : undefined
                  }
                >
                  <Input.Password autoComplete="new-password" disabled={!username} placeholder={s?.passwordSet ? '•••••• (stored)' : ''} />
                </Form.Item>
              </Col>
              <Col xs={24} md={12}>
                <Form.Item name="fromAddress" label="Sender address" rules={[{ required: true, message: 'Enter the sender address' }, { type: 'email', message: 'Invalid e-mail address' }]}>
                  <Input placeholder="it-cmdb@example.com" />
                </Form.Item>
              </Col>
              <Col xs={24} md={12}>
                <Form.Item name="fromName" label="Sender name">
                  <Input placeholder="IT CMDB" />
                </Form.Item>
              </Col>
              <Col span={24}>
                <Form.Item
                  name="allowInvalidCertificates"
                  label="Accept self-signed TLS certificates"
                  valuePropName="checked"
                  extra="Only for internal relays with their own certificate. Leave off for public servers."
                >
                  <Switch />
                </Form.Item>
              </Col>
            </Row>
            <Space>
              <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={() => save()}>
                Save
              </Button>
              {s?.updatedAt && <Typography.Text type="secondary">Last saved {fmtDateTime(s.updatedAt)}</Typography.Text>}
            </Space>
          </Form>
        </Card>
      </Col>
      <Col xs={24} xl={9}>
        <Space orientation="vertical" size={16} style={{ width: '100%' }}>
          <Card title="Send a test e-mail">
            <Typography.Paragraph type="secondary">Uses the saved settings. Save your changes first.</Typography.Paragraph>
            <Space.Compact style={{ width: '100%' }}>
              <Input prefix={<MailOutlined />} value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="name@example.com" />
              <Button type="primary" icon={<SendOutlined />} loading={testing} disabled={!EMAIL_RE.test(testTo) || !s?.configured} onClick={sendTest}>
                Send
              </Button>
            </Space.Compact>
            {testResult && <Alert style={{ marginTop: 12 }} type={testResult.ok ? 'success' : 'error'} showIcon title={testResult.ok ? 'Test e-mail sent' : 'Sending failed'} description={testResult.text} />}
          </Card>
          <Alert
            type="info"
            showIcon
            title="Which server should I use?"
            description={
              <div>
                <p style={{ margin: '0 0 8px' }}>
                  Best is an <strong>internal SMTP relay</strong> that accepts mail from the App Service outbound IPs, or <strong>Azure Communication Services</strong> (SMTP with an Entra application).
                </p>
                <p style={{ margin: 0 }}>
                  Microsoft is retiring basic SMTP AUTH with username/password for Exchange Online mailboxes, so a normal mailbox login may stop working. The password is stored encrypted in the database and is never shown again.
                </p>
              </div>
            }
          />
        </Space>
      </Col>
    </Row>
  );
}

// ---------------------------------------------------------------------------
// Warranty notifications
// ---------------------------------------------------------------------------

type WarrantyForm = Omit<WarrantyNotificationSettings, 'thresholds'> & { thresholds: (string | number)[] };

function WarrantyTab() {
  const { message } = App.useApp();
  const plants = usePlants();
  const [form] = Form.useForm<WarrantyForm>();
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [preview, setPreview] = useState<WarrantyPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [plantRecipients, setPlantRecipients] = useState<Record<string, string[]>>({});
  const settings = useQuery({ queryKey: ['settings', 'notifications'], queryFn: () => http.get<NotificationSettingsDto>('/api/settings/notifications') });
  const email = useQuery({ queryKey: ['settings', 'email'], queryFn: () => http.get<EmailSettingsDto>('/api/settings/email') });
  const enabled = Form.useWatch('enabled', form);

  useEffect(() => {
    if (!settings.data) return;
    form.setFieldsValue({ ...settings.data, thresholds: settings.data.thresholds.map(String) });
    setPlantRecipients(settings.data.plantRecipients ?? {});
  }, [settings.data, form]);

  const save = async () => {
    const v = await form.validateFields();
    const thresholds = [...new Set(v.thresholds.map((t) => Number(t)).filter((t) => Number.isInteger(t) && t >= 0 && t <= 730))];
    const badPlant = Object.entries(plantRecipients).find(([, list]) => list.some((e) => !EMAIL_RE.test(e)));
    if (badPlant) {
      message.error('Please fix the invalid e-mail address in the plant recipients.');
      return;
    }
    setSaving(true);
    try {
      await http.put('/api/settings/notifications', { ...v, thresholds, plantRecipients });
      message.success('Notification settings saved');
      await settings.refetch();
      setPreview(null);
    } catch (e) {
      message.error(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const loadPreview = async () => {
    setPreviewing(true);
    try {
      setPreview(await http.get<WarrantyPreview>('/api/notifications/warranty/preview'));
    } catch (e) {
      message.error(errorText(e));
    } finally {
      setPreviewing(false);
    }
  };

  const runNow = async () => {
    setRunning(true);
    try {
      const res = await http.post<RunResult>('/api/notifications/warranty/run');
      if (res.run.status === 'ok') message.success(res.run.emails ? `Sent ${res.run.emails} e-mail(s) covering ${res.run.items} device(s)` : 'Nothing to send – all due devices were already notified');
      else if (res.run.status === 'skipped') message.warning(res.run.error ?? 'Skipped');
      else message.error(res.run.error ?? 'Sending failed');
      await settings.refetch();
      setPreview(null);
    } catch (e) {
      message.error(errorText(e));
    } finally {
      setRunning(false);
    }
  };

  const s = settings.data;
  const plantRows = useMemo(() => (plants.data ?? []) as Plant[], [plants.data]);

  return (
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      {email.data && !email.data.configured && (
        <Alert type="warning" showIcon title="The e-mail server is not configured yet" description="Configure the SMTP server on the first tab – notifications are skipped until then." />
      )}
      <Card
        title="Warranty / support contract reminders"
        loading={settings.isLoading}
        extra={
          s?.lastRun && (
            <Typography.Text type="secondary">
              Last run {fromNow(s.lastRun.started_at)}: <Tag color={RUN_STATUS[s.lastRun.status].color}>{RUN_STATUS[s.lastRun.status].label}</Tag>
            </Typography.Text>
          )
        }
      >
        <Form form={form} layout="vertical" disabled={saving}>
          <Form.Item name="enabled" valuePropName="checked" style={{ marginBottom: 12 }}>
            <Switch checkedChildren="On" unCheckedChildren="Off" />
          </Form.Item>
          <Typography.Paragraph type="secondary" style={{ marginTop: -8 }}>
            Once a day, every recipient receives one e-mail listing the devices whose warranty end reaches a reminder stage. Each device is reported only once per stage.
          </Typography.Paragraph>
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item
                name="thresholds"
                label="Remind … days before the warranty ends"
                rules={[{ validator: (_, v: (string | number)[]) => (v?.every((t) => /^\d+$/.test(String(t)) && Number(t) <= 730) ? Promise.resolve() : Promise.reject(new Error('Whole numbers between 0 and 730'))) }]}
              >
                <Select mode="tags" tokenSeparators={[',', ' ']} options={[180, 90, 60, 30, 14, 7].map((d) => ({ value: String(d), label: `${d} days` }))} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="includeExpired" label="When the warranty has ended" valuePropName="checked">
                <Switch checkedChildren="Notify once" unCheckedChildren="Don't notify" />
              </Form.Item>
            </Col>
            <Col xs={12} md={6}>
              <Form.Item name="sendHour" label="Send daily at">
                <Select options={Array.from({ length: 24 }, (_, h) => ({ value: h, label: `${String(h).padStart(2, '0')}:00` }))} />
              </Form.Item>
            </Col>
            <Col xs={12} md={6}>
              <Form.Item name="timezone" label="Time zone">
                <Select showSearch options={TIMEZONES.map((t) => ({ value: t, label: t }))} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="excludeStatuses" label="Ignore devices with status">
                <Select mode="multiple" options={ASSET_STATUSES.map((st) => ({ value: st, label: ASSET_STATUS_META[st].label }))} />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item name="recipients" label="Recipients for all plants" rules={[emailRule()]} extra="E.g. the central IT infrastructure team mailbox. Press Enter after each address.">
                <Select mode="tags" tokenSeparators={[',', ';', ' ']} placeholder="it-infrastructure@example.com" open={false} suffixIcon={null} />
              </Form.Item>
            </Col>
          </Row>

          <Divider titlePlacement="start" plain style={{ marginTop: 0 }}>
            Recipients per plant (only devices of that plant)
          </Divider>
          <Table<Plant>
            rowKey="id"
            pagination={false}
            dataSource={plantRows}
            loading={plants.isLoading}
            columns={[
              { title: 'Plant', key: 'plant', width: 260, render: (_, p) => <span><Tag>{p.code}</Tag>{p.name}</span> },
              {
                title: 'Recipients',
                key: 'recipients',
                render: (_, p) => {
                  const value = plantRecipients[p.id] ?? [];
                  const invalid = value.filter((e) => !EMAIL_RE.test(e));
                  return (
                    <Select
                      mode="tags"
                      value={value}
                      status={invalid.length ? 'error' : undefined}
                      tokenSeparators={[',', ';', ' ']}
                      placeholder="it-site@example.com"
                      open={false}
                      suffixIcon={null}
                      style={{ width: '100%' }}
                      onChange={(list: string[]) => setPlantRecipients((cur) => ({ ...cur, [p.id]: list }))}
                    />
                  );
                },
              },
            ]}
          />
          <Space style={{ marginTop: 16 }} wrap>
            <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={save}>
              Save
            </Button>
            {s?.updatedAt && <Typography.Text type="secondary">Last saved {fmtDateTime(s.updatedAt)}</Typography.Text>}
            {s?.enabled && s.nextRun && <Typography.Text type="secondary">· next scheduled check {fmtDateTime(s.nextRun)}</Typography.Text>}
          </Space>
        </Form>
      </Card>

      <Card
        title="What would be sent now"
        extra={
          <Space>
            <Button icon={<EyeOutlined />} loading={previewing} onClick={loadPreview}>
              Preview
            </Button>
            <Popconfirm
              title="Send the warranty e-mails now?"
              description="Devices included now will not be reported again at the next scheduled run."
              onConfirm={runNow}
              disabled={!s?.enabled}
            >
              <Tooltip title={!s?.enabled ? 'Turn notifications on and save first' : undefined}>
                <Button type="primary" icon={<SendOutlined />} loading={running} disabled={!s?.enabled}>
                  Send now
                </Button>
              </Tooltip>
            </Popconfirm>
          </Space>
        }
      >
        {!preview ? (
          <Typography.Text type="secondary">Click Preview to see which devices and recipients the next e-mail would include (based on the saved settings).</Typography.Text>
        ) : (
          <Space orientation="vertical" size={12} style={{ width: '100%' }}>
            <Space wrap>
              <Typography.Text>
                <strong>{preview.items.length}</strong> device(s) due on {fmtDate(preview.today)}
              </Typography.Text>
              {preview.recipients.map((r) => (
                <Tag key={r.email} icon={<MailOutlined />}>
                  {r.email} · {r.count}
                </Tag>
              ))}
              {preview.unrouted > 0 && <Tag color="warning">{preview.unrouted} without recipient</Tag>}
            </Space>
            <Table
              rowKey="id"
              dataSource={preview.items}
              pagination={{ pageSize: 10, hideOnSinglePage: true }}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Nothing to send – every due device has been notified already" /> }}
              scroll={{ x: 760 }}
              columns={[
                { title: 'Device', dataIndex: 'name', render: (v, i) => <Space size={6}><AssetTypeTag type={i.type} short /><Link to={`/assets/${i.id}`}>{v}</Link></Space> },
                { title: 'Plant', dataIndex: 'plant_code', width: 80, render: (v) => v ?? '–' },
                { title: 'Model', key: 'model', render: (_, i) => [i.manufacturer, i.model].filter(Boolean).join(' ') || '–' },
                { title: 'Warranty end', dataIndex: 'warranty_end', width: 130, render: (v) => <WarrantyDate value={v} /> },
                { title: 'Stage', dataIndex: 'thresholds', width: 160, render: (t: number[]) => t.map((x) => <Tag key={x}>{thresholdLabel(x)}</Tag>) },
              ]}
            />
          </Space>
        )}
      </Card>
    </Space>
  );
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function HistoryTab() {
  const runs = useQuery({ queryKey: ['notifications', 'runs'], queryFn: () => http.get<NotificationRun[]>('/api/notifications/runs', { limit: 100 }) });
  const sent = useQuery({ queryKey: ['notifications', 'log'], queryFn: () => http.get<NotificationLogEntry[]>('/api/notifications/log', { limit: 300 }) });
  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} xl={10}>
        <Card title="Runs">
          <Table<NotificationRun>
            rowKey="id"
            loading={runs.isLoading}
            dataSource={runs.data ?? []}
            pagination={{ pageSize: 15, hideOnSinglePage: true }}
            expandable={{ rowExpandable: (r) => !!r.error, expandedRowRender: (r) => <Typography.Text type={r.status === 'error' ? 'danger' : 'secondary'}>{r.error}</Typography.Text> }}
            columns={[
              { title: 'Started', dataIndex: 'started_at', render: (v) => fmtDateTime(v) },
              { title: 'Trigger', dataIndex: 'trigger', render: (v) => (v === 'manual' ? 'manual' : 'scheduled') },
              { title: 'Status', dataIndex: 'status', render: (v: NotificationRun['status']) => <Tag color={RUN_STATUS[v].color}>{RUN_STATUS[v].label}</Tag> },
              { title: 'Devices', dataIndex: 'items', align: 'right' },
              { title: 'E-mails', dataIndex: 'emails', align: 'right' },
            ]}
          />
        </Card>
      </Col>
      <Col xs={24} xl={14}>
        <Card title="Sent reminders">
          <Table<NotificationLogEntry>
            rowKey="id"
            loading={sent.isLoading}
            dataSource={sent.data ?? []}
            pagination={{ pageSize: 15, hideOnSinglePage: true }}
            scroll={{ x: 720 }}
            columns={[
              { title: 'Sent', dataIndex: 'sent_at', width: 150, render: (v) => fmtDateTime(v) },
              {
                title: 'Device',
                dataIndex: 'asset_name',
                render: (v, r) => (
                  <Space size={6}>
                    {r.asset_type && <AssetTypeTag type={r.asset_type} short />}
                    <Link to={`/assets/${r.asset_id}`}>{v ?? r.asset_id}</Link>
                    {r.plant_code && <Typography.Text type="secondary">{r.plant_code}</Typography.Text>}
                  </Space>
                ),
              },
              { title: 'Stage', dataIndex: 'threshold_days', width: 100, render: (t: number) => <Tag>{thresholdLabel(t)}</Tag> },
              { title: 'Warranty end', dataIndex: 'warranty_end', width: 110, render: (v) => fmtDate(v) },
              { title: 'Recipients', dataIndex: 'recipients', ellipsis: true, render: (l: string[]) => l.join(', ') || '–' },
            ]}
          />
        </Card>
      </Col>
    </Row>
  );
}

// ---------------------------------------------------------------------------

export function SettingsPage() {
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  if (!can('settings.manage')) return <Result status="403" title="No access" subTitle="Settings are restricted to administrators." />;
  const tab = params.get('tab') ?? 'email';

  return (
    <div>
      <PageHeader
        title="Settings & notifications"
        subtitle="E-mail server, warranty reminders and sign-in with Microsoft. All changes are recorded in the audit log."
        crumbs={[{ title: 'Administration' }, { title: 'Settings & notifications' }]}
      />
      <Card styles={{ body: { paddingTop: 0 } }}>
        <Tabs
          activeKey={tab}
          onChange={(key) => {
            const next = new URLSearchParams(params);
            if (key === 'email') next.delete('tab');
            else next.set('tab', key);
            setParams(next, { replace: true });
          }}
          items={[
            { key: 'email', label: 'E-mail server (SMTP)', children: <SmtpTab /> },
            { key: 'warranty', label: 'Warranty notifications', children: <WarrantyTab /> },
            { key: 'history', label: 'History', children: <HistoryTab /> },
            { key: 'entra', label: 'Microsoft Entra ID', children: <EntraSettingsTab /> },
          ]}
        />
      </Card>
    </div>
  );
}
