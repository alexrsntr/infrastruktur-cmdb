import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Col, Descriptions, Form, InputNumber, Progress, Row, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import { ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import {
  READ_ONLY_PERCENT,
  formatStorage,
  type DbStorageCheckResult,
  type DbStorageDetails,
  type DbStorageLevel,
  type DbStorageSettings,
} from '../../../../shared/dbStorage';
import { errorText, http } from '../../lib/api';
import { fmtDateTime, fromNow } from '../../lib/format';
import { C, STATUS } from '../../theme';

const LEVEL_META: Record<DbStorageLevel | 'off', { label: string; color: string; text: string; tag: string }> = {
  ok: { label: 'OK', color: STATUS.ok, text: C.okText, tag: 'success' },
  warning: { label: 'Warning', color: STATUS.warn, text: C.warnText, tag: 'warning' },
  critical: { label: 'Critical', color: STATUS.bad, text: C.badText, tag: 'error' },
  off: { label: 'Not monitored', color: STATUS.idle, text: C.muted, tag: 'default' },
};

/** Settings → Database storage: fill level of the PostgreSQL server and the warning thresholds */
export function DbStorageTab() {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<DbStorageSettings>();
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const details = useQuery({ queryKey: ['settings', 'db-storage'], queryFn: () => http.get<DbStorageDetails>('/api/settings/db-storage') });
  const emailEnabled = Form.useWatch('emailEnabled', form);

  useEffect(() => {
    if (details.data) form.setFieldsValue(details.data.settings);
  }, [details.data, form]);

  const refreshAll = (next: DbStorageDetails) => {
    queryClient.setQueryData(['settings', 'db-storage'], next);
    void queryClient.invalidateQueries({ queryKey: ['system', 'db-storage'] });
  };

  const save = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      refreshAll(await http.put<DbStorageDetails>('/api/settings/db-storage', v));
      message.success('Storage settings saved');
    } catch (e) {
      message.error(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const check = async () => {
    setChecking(true);
    try {
      const res = await http.post<DbStorageCheckResult & { details: DbStorageDetails }>('/api/settings/db-storage/check', {});
      refreshAll(res.details);
      if (res.error) message.warning(res.error);
      else if (res.emails) message.success(`Threshold reached – ${res.emails} e-mail(s) sent`);
      else message.success('Measured – no new e-mail needed');
    } catch (e) {
      message.error(errorText(e));
    } finally {
      setChecking(false);
    }
  };

  const d = details.data;
  const meta = LEVEL_META[d?.level ?? 'off'];

  return (
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      {d && !d.smtpConfigured && (
        <Alert
          type="warning"
          showIcon
          title="The e-mail server is not configured yet"
          description="Until then administrators only see the warning banner in the app. Configure the SMTP server on the first tab to get e-mails."
        />
      )}
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card
            title="Fill level"
            loading={details.isLoading}
            extra={
              <Button icon={<ReloadOutlined />} loading={checking} onClick={check}>
                Check now
              </Button>
            }
            style={{ height: '100%' }}
          >
            {d && (
              <Space orientation="vertical" size={12} style={{ width: '100%' }}>
                <Space align="center" size={12} wrap>
                  <Typography.Text style={{ fontSize: 26, fontWeight: 700, color: meta.text }}>{d.percent == null ? '–' : `${d.percent} %`}</Typography.Text>
                  <Tag color={meta.tag}>{meta.label}</Tag>
                  <Typography.Text type="secondary">
                    {formatStorage(d.usedBytes)} of {d.limitBytes ? formatStorage(d.limitBytes) : 'unknown size'}
                  </Typography.Text>
                </Space>
                {d.percent != null && (
                  <Progress percent={Math.min(100, d.percent)} showInfo={false} strokeColor={meta.color} strokeWidth={12} />
                )}
                <Descriptions
                  size="small"
                  column={1}
                  items={[
                    { key: 'db', label: 'This database', children: formatStorage(d.breakdown.database) },
                    { key: 'other', label: 'Other databases on the server', children: formatStorage(d.breakdown.otherDatabases) },
                    {
                      key: 'wal',
                      label: 'Write-ahead log',
                      children: d.breakdown.wal == null ? <Typography.Text type="secondary">not readable with the app's rights – the thresholds leave room for it</Typography.Text> : formatStorage(d.breakdown.wal),
                    },
                    {
                      key: 'mail',
                      label: 'Last e-mail',
                      children: d.lastNotification ? (
                        <span title={fmtDateTime(d.lastNotification.at)}>
                          <Tag color={LEVEL_META[d.lastNotification.level].tag}>{LEVEL_META[d.lastNotification.level].label}</Tag>
                          at {d.lastNotification.percent} % {fromNow(d.lastNotification.at)} to {d.lastNotification.recipients} recipient(s)
                        </span>
                      ) : (
                        <Typography.Text type="secondary">none yet</Typography.Text>
                      ),
                    },
                  ]}
                />
                <Typography.Text type="secondary" className="fs-small">
                  Checked every hour. Administrators see a banner from the warning level on; at {READ_ONLY_PERCENT} % Azure switches the database to read-only and
                  nothing can be saved anymore (not even a sign-in).
                </Typography.Text>
              </Space>
            )}
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="Largest tables" loading={details.isLoading} style={{ height: '100%' }}>
            <Table
              size="small"
              rowKey="name"
              pagination={false}
              dataSource={d?.tables ?? []}
              columns={[
                { title: 'Content', dataIndex: 'label', render: (v: string, t) => <span title={t.name}>{v}</span> },
                { title: 'Size', dataIndex: 'bytes', align: 'right', width: 120, render: (v: number) => formatStorage(v) },
              ]}
            />
          </Card>
        </Col>
      </Row>
      <Card title="Warning" loading={details.isLoading}>
        <Form form={form} layout="vertical" requiredMark={false} style={{ maxWidth: 760 }}>
          <Row gutter={16}>
            <Col xs={24} md={8}>
              <Form.Item
                name="limitGb"
                label="Storage size of the server"
                rules={[{ required: true, message: 'Enter the storage size' }]}
                extra="Azure portal → PostgreSQL server → Compute + storage. Update it after enlarging the storage; 0 = no warning."
              >
                <InputNumber min={0} max={65536} step={8} style={{ width: '100%' }} addonAfter="GB" />
              </Form.Item>
            </Col>
            <Col xs={12} md={8}>
              <Form.Item name="warnPercent" label="Warning from" rules={[{ required: true, message: 'Required' }]}>
                <InputNumber min={10} max={99} style={{ width: '100%' }} addonAfter="%" />
              </Form.Item>
            </Col>
            <Col xs={12} md={8}>
              <Form.Item
                name="criticalPercent"
                label="Critical from"
                dependencies={['warnPercent']}
                rules={[
                  { required: true, message: 'Required' },
                  ({ getFieldValue }) => ({
                    validator: (_, v) => (v == null || v > getFieldValue('warnPercent') ? Promise.resolve() : Promise.reject(new Error('Must be higher than the warning'))),
                  }),
                ]}
              >
                <InputNumber min={10} max={99} style={{ width: '100%' }} addonAfter="%" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="emailEnabled" label="E-mail when a level is reached (once per level)" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Row gutter={16}>
            <Col xs={24} md={8}>
              <Form.Item name="notifyAdmins" label="All administrators" valuePropName="checked">
                <Switch disabled={!emailEnabled} />
              </Form.Item>
            </Col>
            <Col xs={24} md={16}>
              <Form.Item name="recipients" label="Additional recipients">
                <Select mode="tags" tokenSeparators={[',', ' ', ';']} disabled={!emailEnabled} placeholder="e.g. it-infrastructure@example.com" open={false} />
              </Form.Item>
            </Col>
          </Row>
          <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={save}>
            Save
          </Button>
        </Form>
      </Card>
    </Space>
  );
}
