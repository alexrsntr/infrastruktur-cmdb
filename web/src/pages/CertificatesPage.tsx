import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Segmented,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Timeline,
  Typography,
} from 'antd';
import {
  ClockCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  ExclamationCircleOutlined,
  FileProtectOutlined,
  MailOutlined,
  MinusCircleOutlined,
  PlusOutlined,
  SearchOutlined,
  UserOutlined,
} from '@ant-design/icons';
import {
  CERT_DAYS,
  CERT_EXPIRY_META,
  CERT_KINDS,
  CERT_KIND_META,
  CERT_STATUSES,
  CERT_STATUS_META,
  CERT_WATCHED_STATUSES,
  MAX_CERT_RESPONSIBLES,
  certExpiry,
  daysLeftText,
  responsibleEmails,
  type Certificate,
  type CertificateResponsible,
  type CertificateList,
} from '../../../shared/certificates';
import type { Application } from '../../../shared/applications';
import type { Asset, AuditEntry, Paged } from '../../../shared/model';
import { errorText, http } from '../lib/api';
import { fmtDate, fmtDateTime } from '../lib/format';
import { useInvalidate, usePlants } from '../lib/queries';
import { useSession } from '../lib/session';
import { PageHeader } from '../components/PageHeader';
import { StatTile } from '../components/Simple';
import { DateStringInput } from '../components/DateStringInput';

type Due = 'all' | 'soon' | 'expired' | 'no_responsible';

export const useCertificates = (q: Record<string, string | undefined>) =>
  useQuery({ queryKey: ['certificates', q], queryFn: () => http.get<CertificateList>('/api/certificates', q) });

const dash = (v: React.ReactNode) => (v === null || v === undefined || v === '' ? <span className="muted">–</span> : v);

/** "in 12 days" in the colour of the urgency; replaced / retired certificates stay grey */
export function ExpiryTag({ cert }: { cert: Pick<Certificate, 'days_left' | 'status'> }) {
  if (!CERT_WATCHED_STATUSES.includes(cert.status)) return <Tag>{daysLeftText(cert.days_left)}</Tag>;
  const e = certExpiry(cert.days_left);
  return (
    <Tag color={CERT_EXPIRY_META[e].color} icon={e === 'ok' ? undefined : e === 'expired' ? <ExclamationCircleOutlined /> : <ClockCircleOutlined />}>
      {daysLeftText(cert.days_left)}
    </Tag>
  );
}

/** Certificates with expiry date, responsible person and e-mail reminders */
export function CertificatesPage() {
  const { can } = useSession();
  const plants = usePlants();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [plantId, setPlantId] = useState<string | undefined>(params.get('plantId') ?? undefined);
  const [due, setDue] = useState<Due>((params.get('due') as Due) || 'all');
  const [editing, setEditing] = useState<{ open: boolean; cert?: Certificate }>({ open: false });
  const openId = params.get('open');

  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const list = useCertificates({ q: q || undefined, plantId, due: due === 'all' ? undefined : due });
  const counts = list.data?.counts;
  const setOpen = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('open', id);
    else next.delete('open');
    setParams(next, { replace: true });
  };

  return (
    <div>
      <PageHeader
        icon={
          <span className="page-icon">
            <FileProtectOutlined />
          </span>
        }
        title="Certificates"
        subtitle="SSL/TLS, CA, VPN and other certificates with expiry date and responsible persons. The responsible persons are reminded by e-mail before a certificate expires."
        extra={
          can('asset.write') && (
            <Button type="primary" size="large" icon={<PlusOutlined />} onClick={() => setEditing({ open: true })}>
              Add certificate
            </Button>
          )
        }
      />

      <div className="tile-grid" style={{ marginBottom: 20 }}>
        <StatTile icon={<ExclamationCircleOutlined />} color="#c4262e" value={counts?.expired ?? '–'} label="Expired" onClick={() => setDue('expired')} active={due === 'expired'} />
        <StatTile icon={<ClockCircleOutlined />} color="#d4380d" value={counts?.critical ?? '–'} label={`Expire within ${CERT_DAYS.critical} days`} onClick={() => setDue('soon')} />
        <StatTile icon={<ClockCircleOutlined />} color="#b26a00" value={counts?.warning ?? '–'} label={`Expire within ${CERT_DAYS.warning} days`} onClick={() => setDue('soon')} />
        <StatTile icon={<UserOutlined />} color="#6b35b5" value={counts?.no_responsible ?? '–'} label="Without responsible e-mail" onClick={() => setDue('no_responsible')} active={due === 'no_responsible'} />
        <StatTile icon={<FileProtectOutlined />} value={counts?.total ?? '–'} label="Certificates" onClick={() => setDue('all')} active={due === 'all'} />
      </div>

      <Card>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 }}>
          <Input
            allowClear
            prefix={<SearchOutlined className="muted" />}
            placeholder="Search name, host name, responsible, application…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: 340, maxWidth: '100%' }}
          />
          {(plants.data?.length ?? 0) > 1 && (
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="All plants"
              value={plantId}
              onChange={setPlantId}
              style={{ width: 220 }}
              options={(plants.data ?? []).map((p) => ({ value: p.id, label: `${p.code} – ${p.name}` }))}
            />
          )}
          <div style={{ flex: 1 }} />
          <Segmented
            value={due}
            onChange={(v) => setDue(v as Due)}
            options={[
              { value: 'all', label: 'All' },
              { value: 'soon', label: `Expiring (${CERT_DAYS.warning} days)` },
              { value: 'expired', label: 'Expired' },
              { value: 'no_responsible', label: 'No responsible' },
            ]}
          />
        </div>
        <Table<Certificate>
          rowKey="id"
          loading={list.isLoading}
          dataSource={list.data?.items ?? []}
          pagination={(list.data?.items.length ?? 0) > 50 ? { pageSize: 50 } : false}
          scroll={{ x: 980 }}
          onRow={(c) => ({ onClick: () => setOpen(c.id), style: { cursor: 'pointer' } })}
          rowClassName={(c) => (CERT_WATCHED_STATUSES.includes(c.status) ? '' : 'muted-row')}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={due === 'all' && !q ? 'No certificates documented yet. Add your web, VPN and CA certificates to be reminded before they expire.' : 'No certificate matches.'}
              />
            ),
          }}
          columns={[
            {
              title: 'Certificate',
              key: 'name',
              render: (_, c) => (
                <div>
                  <div style={{ fontWeight: 650, fontSize: 15 }}>{c.name}</div>
                  <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                    {[c.common_name && c.common_name !== c.name ? c.common_name : null, CERT_KIND_META[c.kind].label, c.issuer].filter(Boolean).join(' · ')}
                  </Typography.Text>
                </div>
              ),
            },
            {
              title: 'Expires',
              key: 'expires',
              width: 190,
              sorter: (a, b) => a.expires_on.localeCompare(b.expires_on),
              render: (_, c) => (
                <Space orientation="vertical" size={2}>
                  <span style={{ fontWeight: 600 }}>{fmtDate(c.expires_on)}</span>
                  <ExpiryTag cert={c} />
                </Space>
              ),
            },
            {
              title: 'Responsible',
              key: 'responsible',
              width: 220,
              render: (_, c) =>
                c.responsibles.length ? (
                  <div>
                    {c.responsibles.slice(0, 2).map((r, i) => (
                      <div key={i} style={{ marginBottom: 2 }}>
                        <div>{r.name ?? r.email}</div>
                        {r.name && r.email && (
                          <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                            {r.email}
                          </Typography.Text>
                        )}
                      </div>
                    ))}
                    {c.responsibles.length > 2 && (
                      <Typography.Text type="secondary" style={{ fontSize: 12.5 }} title={c.responsibles.slice(2).map((r) => r.name ?? r.email).join(', ')}>
                        +{c.responsibles.length - 2} more
                      </Typography.Text>
                    )}
                  </div>
                ) : (
                  <Tag color="purple">nobody</Tag>
                ),
            },
            {
              title: 'Used for',
              key: 'used',
              width: 230,
              responsive: ['md'],
              render: (_, c) => (
                <div style={{ fontSize: 13 }}>
                  <div>{c.plant_code ?? <span className="muted">All plants</span>}</div>
                  {c.application_name && <div className="muted">{c.application_name}</div>}
                  {c.asset_name && <div className="muted">{c.asset_name}</div>}
                </div>
              ),
            },
            {
              title: 'Status',
              key: 'status',
              width: 150,
              responsive: ['lg'],
              render: (_, c) => (
                <Space orientation="vertical" size={2}>
                  <Tag color={CERT_STATUS_META[c.status].color}>{CERT_STATUS_META[c.status].label}</Tag>
                  {c.auto_renew && <Typography.Text type="secondary" style={{ fontSize: 12 }}>auto-renewed</Typography.Text>}
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <CertificateDrawer id={openId} onClose={() => setOpen(null)} onEdit={(cert) => setEditing({ open: true, cert })} />
      <CertificateFormModal state={editing} onClose={() => setEditing({ open: false })} onSaved={(c) => setOpen(c.id)} />
    </div>
  );
}

interface History {
  changes: AuditEntry[];
  reminders: { threshold_days: number; expires_on: string; recipients: string[]; sent_at: string }[];
}

function CertificateDrawer({ id, onClose, onEdit }: { id: string | null; onClose: () => void; onEdit: (c: Certificate) => void }) {
  const { can } = useSession();
  const { message } = App.useApp();
  const invalidate = useInvalidate();
  const q = useQuery({ queryKey: ['certificate', id], queryFn: () => http.get<Certificate>(`/api/certificates/${id}`), enabled: !!id, retry: false });
  const history = useQuery({ queryKey: ['certificate-history', id], queryFn: () => http.get<History>(`/api/certificates/${id}/history`), enabled: !!id });
  const c = q.data;

  const remove = async () => {
    try {
      await http.del(`/api/certificates/${id}`);
      message.success('Certificate deleted');
      onClose();
      await invalidate();
    } catch (e) {
      message.error(errorText(e));
    }
  };

  return (
    <Drawer
      open={!!id}
      onClose={onClose}
      width={620}
      title={c?.name ?? 'Certificate'}
      extra={
        c && (
          <Space>
            {can('asset.edit') && (
              <Button icon={<EditOutlined />} onClick={() => onEdit(c)}>
                Edit
              </Button>
            )}
            {can('asset.delete') && (
              <Popconfirm title={`Delete ${c.name}?`} description="Its reminders are deleted too." onConfirm={remove} okButtonProps={{ danger: true }}>
                <Button danger icon={<DeleteOutlined />} aria-label="Delete certificate" />
              </Popconfirm>
            )}
          </Space>
        )
      }
    >
      {q.isLoading ? (
        <Spin />
      ) : q.isError || !c ? (
        <Alert type="error" showIcon title="Certificate not found" description={errorText(q.error)} />
      ) : (
        <Space orientation="vertical" size={20} style={{ width: '100%' }}>
          <Space wrap>
            <ExpiryTag cert={c} />
            <Tag color={CERT_STATUS_META[c.status].color}>{CERT_STATUS_META[c.status].label}</Tag>
            <Tag>{CERT_KIND_META[c.kind].label}</Tag>
            {c.auto_renew && <Tag color="cyan">Auto-renewed</Tag>}
          </Space>
          {CERT_WATCHED_STATUSES.includes(c.status) && !responsibleEmails(c.responsibles).length && (
            <Alert type="warning" showIcon title="No responsible person is reminded" description="Enter the e-mail address of at least one responsible person so that the reminders reach someone." />
          )}
          <Descriptions column={1} size="small" bordered styles={{ label: { width: 170 } }}>
            <Descriptions.Item label="Expires on">
              <strong>{fmtDate(c.expires_on)}</strong> ({daysLeftText(c.days_left)})
            </Descriptions.Item>
            <Descriptions.Item label="Valid from">{dash(c.valid_from && fmtDate(c.valid_from))}</Descriptions.Item>
            <Descriptions.Item label="Common name">{dash(c.common_name)}</Descriptions.Item>
            <Descriptions.Item label="Further host names (SAN)">{dash(c.sans)}</Descriptions.Item>
            <Descriptions.Item label="Issuer">{dash(c.issuer)}</Descriptions.Item>
            <Descriptions.Item label="Serial number">{dash(c.serial_number && <span className="mono">{c.serial_number}</span>)}</Descriptions.Item>
            <Descriptions.Item label={c.responsibles.length > 1 ? 'Responsible persons' : 'Responsible'}>
              {c.responsibles.length
                ? c.responsibles.map((r, i) => <div key={i}>{[r.name, r.email].filter(Boolean).join(' · ')}</div>)
                : dash(null)}
            </Descriptions.Item>
            <Descriptions.Item label="Also reminded">{dash(c.notify_emails.join(', '))}</Descriptions.Item>
            <Descriptions.Item label="Plant">{c.plant_id ? <Link to={`/plants/${c.plant_id}`}>{c.plant_code} – {c.plant_name}</Link> : 'All plants (central)'}</Descriptions.Item>
            <Descriptions.Item label="Application">{dash(c.application_id && <Link to={`/applications/${c.application_id}`}>{c.application_name}</Link>)}</Descriptions.Item>
            <Descriptions.Item label="Device">{dash(c.asset_id && <Link to={`/assets/${c.asset_id}`}>{c.asset_name}</Link>)}</Descriptions.Item>
            <Descriptions.Item label="Installed on">{dash(c.installed_on)}</Descriptions.Item>
            <Descriptions.Item label="Description">{dash(c.description && <span style={{ whiteSpace: 'pre-line' }}>{c.description}</span>)}</Descriptions.Item>
          </Descriptions>

          <div>
            <Typography.Title level={5}>Reminders sent</Typography.Title>
            {history.data?.reminders.length ? (
              <Timeline
                items={history.data.reminders.map((r) => ({
                  icon: <MailOutlined />,
                  content: (
                    <span>
                      {fmtDateTime(r.sent_at)} – {r.threshold_days ? `${r.threshold_days} days before` : 'after expiry'} ({fmtDate(r.expires_on)})
                      <div className="muted" style={{ fontSize: 12.5 }}>
                        {r.recipients.join(', ')}
                      </div>
                    </span>
                  ),
                }))}
              />
            ) : (
              <Typography.Text type="secondary">No reminder sent yet.</Typography.Text>
            )}
          </div>
          <div>
            <Typography.Title level={5}>Changes</Typography.Title>
            {history.data?.changes.length ? (
              <Timeline
                items={history.data.changes.map((h) => ({
                  content: (
                    <span>
                      <strong>{h.user_name ?? 'System'}</strong> {h.action === 'create' ? 'added the certificate' : h.action === 'update' ? 'changed' : h.action} · {fmtDateTime(h.at)}
                      {h.action === 'update' && h.changes && (
                        <div className="muted" style={{ fontSize: 12.5 }}>
                          {Object.entries(h.changes)
                            .map(([k, v]) => `${k}: ${String((v as { from: unknown }).from ?? '–')} → ${String((v as { to: unknown }).to ?? '–')}`)
                            .join(' · ')}
                        </div>
                      )}
                    </span>
                  ),
                }))}
              />
            ) : (
              <Typography.Text type="secondary">No changes recorded.</Typography.Text>
            )}
          </div>
        </Space>
      )}
    </Drawer>
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function CertificateFormModal({ state, onClose, onSaved }: { state: { open: boolean; cert?: Certificate }; onClose: () => void; onSaved?: (c: Certificate) => void }) {
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const invalidate = useInvalidate();
  const plants = usePlants();
  const { scoped, me, can } = useSession();
  const [saving, setSaving] = useState(false);
  const [assetSearch, setAssetSearch] = useState('');
  const c = state.cert;
  const apps = useQuery({ queryKey: ['applications'], queryFn: () => http.get<Application[]>('/api/applications'), enabled: state.open });
  const assets = useQuery({
    queryKey: ['assets', 'certificate-picker', assetSearch],
    queryFn: () => http.get<Paged<Asset>>('/api/assets', { q: assetSearch || undefined, pageSize: 20 }),
    enabled: state.open,
  });
  const assetOptions = useMemo(() => {
    const opts = (assets.data?.items ?? []).map((a) => ({ value: a.id, label: `${a.name}${a.plant_code ? ` · ${a.plant_code}` : ''}` }));
    if (c?.asset_id && !opts.some((o) => o.value === c.asset_id)) opts.unshift({ value: c.asset_id, label: c.asset_name ?? c.asset_id });
    return opts;
  }, [assets.data, c]);

  useEffect(() => {
    if (!state.open) return;
    form.setFieldsValue(
      c
        ? { ...c, responsibles: c.responsibles.length ? c.responsibles : [{ name: null, email: null }] }
        : {
            name: '',
            kind: 'tls',
            status: 'active',
            auto_renew: false,
            plant_id: scoped && me.user.plantScope.length === 1 ? me.user.plantScope[0] : undefined,
            notify_emails: [],
            responsibles: [{ name: me.user.displayName, email: me.user.email ?? null }],
          },
    );
  }, [state.open, c, form, scoped, me.user]);

  const submit = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      const body = {
        ...v,
        plant_id: v.plant_id ?? null,
        application_id: v.application_id ?? null,
        asset_id: v.asset_id ?? null,
        notify_emails: v.notify_emails ?? [],
        // empty rows are dropped by the server
        responsibles: ((v.responsibles ?? []) as Partial<CertificateResponsible>[]).map((r) => ({ name: r.name?.trim() || null, email: r.email?.trim() || null })),
      };
      const saved = c ? await http.put<Certificate>(`/api/certificates/${c.id}`, body) : await http.post<Certificate>('/api/certificates', body);
      message.success(`${saved.name} saved`);
      await invalidate();
      onClose();
      onSaved?.(saved);
    } catch (e) {
      message.error(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={state.open} title={c ? `Edit ${c.name}` : 'Add certificate'} okText="Save" confirmLoading={saving} onOk={submit} onCancel={onClose} width={760} destroyOnHidden>
      <Form form={form} layout="vertical">
        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Form.Item name="name" label="Name" rules={[{ required: true, whitespace: true, max: 200 }]}>
              <Input placeholder="e.g. portal.example.com, VPN gateway MUC" autoFocus />
            </Form.Item>
          </Col>
          <Col xs={12} md={6}>
            <Form.Item name="kind" label="Kind">
              <Select options={CERT_KINDS.map((k) => ({ value: k, label: CERT_KIND_META[k].label }))} />
            </Form.Item>
          </Col>
          <Col xs={12} md={6}>
            <Form.Item name="status" label="Status">
              <Select options={CERT_STATUSES.map((s) => ({ value: s, label: CERT_STATUS_META[s].label, title: CERT_STATUS_META[s].description }))} />
            </Form.Item>
          </Col>
          <Col xs={12} md={6}>
            <Form.Item name="expires_on" label="Expires on" rules={[{ required: true, message: 'Enter the expiry date' }]}>
              <DateStringInput />
            </Form.Item>
          </Col>
          <Col xs={12} md={6}>
            <Form.Item name="valid_from" label="Valid from">
              <DateStringInput />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="auto_renew" label="Renewed automatically (ACME, Intune …)" valuePropName="checked">
              <Switch checkedChildren="Yes" unCheckedChildren="No" />
            </Form.Item>
          </Col>
          <Col span={24}>
            <Form.Item label="Responsible persons" extra="Everyone with an e-mail address receives the reminders before expiry.">
              <Form.List name="responsibles">
                {(fields, { add, remove }) => (
                  <Space orientation="vertical" size={8} style={{ width: '100%' }}>
                    {fields.map((field, i) => (
                      <Row key={field.key} gutter={8} wrap={false} align="top">
                        <Col flex="2 1 0">
                          <Form.Item name={[field.name, 'name']} noStyle>
                            <Input placeholder="Name" maxLength={200} aria-label={`Name of responsible person ${i + 1}`} />
                          </Form.Item>
                        </Col>
                        <Col flex="3 1 0">
                          <Form.Item name={[field.name, 'email']} rules={[{ type: 'email', message: 'Invalid e-mail address' }]} style={{ marginBottom: 0 }}>
                            <Input placeholder="name@example.com" maxLength={254} aria-label={`E-mail of responsible person ${i + 1}`} />
                          </Form.Item>
                        </Col>
                        <Col flex="none">
                          <Button type="text" icon={<MinusCircleOutlined />} onClick={() => remove(field.name)} aria-label={`Remove responsible person ${i + 1}`} />
                        </Col>
                      </Row>
                    ))}
                    <Button type="dashed" icon={<PlusOutlined />} onClick={() => add({ name: null, email: null })} disabled={fields.length >= MAX_CERT_RESPONSIBLES}>
                      Add responsible person
                    </Button>
                  </Space>
                )}
              </Form.List>
            </Form.Item>
          </Col>
          <Col span={24}>
            <Form.Item
              name="notify_emails"
              label="Also remind"
              extra="Team mailboxes or deputies. Press Enter after each address."
              rules={[{ validator: (_, v: string[] | undefined) => (v?.every((e) => EMAIL_RE.test(e)) ?? true ? Promise.resolve() : Promise.reject(new Error('Invalid e-mail address'))) }]}
            >
              <Select mode="tags" tokenSeparators={[',', ';', ' ']} open={false} suffixIcon={null} placeholder="team@example.com" />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="common_name" label="Common name (CN)">
              <Input placeholder="e.g. portal.example.com" maxLength={500} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="issuer" label="Issuer / CA">
              <Input placeholder="e.g. DigiCert, internal PKI" maxLength={300} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="sans" label="Further host names (SAN)">
              <Input placeholder="comma separated" maxLength={4000} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="serial_number" label="Serial number / thumbprint">
              <Input maxLength={200} />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="plant_id" label="Plant" extra={scoped ? undefined : 'Empty = central certificate for all plants'}>
              <Select
                allowClear={!scoped || !c?.plant_id}
                showSearch
                optionFilterProp="label"
                placeholder="All plants"
                options={(plants.data ?? []).map((p) => ({ value: p.id, label: `${p.code} – ${p.name}` }))}
              />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="application_id" label="Application">
              <Select allowClear showSearch optionFilterProp="label" loading={apps.isLoading} options={(apps.data ?? []).map((a) => ({ value: a.id, label: a.name }))} />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="asset_id" label="Device">
              <Select allowClear showSearch filterOption={false} onSearch={setAssetSearch} loading={assets.isFetching} options={assetOptions} placeholder="Search a device" />
            </Form.Item>
          </Col>
          <Col span={24}>
            <Form.Item name="installed_on" label="Installed on">
              <Input placeholder="e.g. load balancer VIP 10.1.2.3, IIS on muc-app10, FortiGate VPN" maxLength={1000} />
            </Form.Item>
          </Col>
          <Col span={24}>
            <Form.Item name="description" label="Notes / renewal procedure">
              <Input.TextArea autoSize={{ minRows: 2, maxRows: 6 }} maxLength={8000} />
            </Form.Item>
          </Col>
        </Row>
        {!can('asset.write') && (
          <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
            As local administrator you can change certificates of your plants – adding new ones is done by the central IT.
          </Typography.Text>
        )}
      </Form>
    </Modal>
  );
}
