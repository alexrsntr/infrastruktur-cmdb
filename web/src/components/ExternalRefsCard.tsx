import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { App, Button, Card, Col, Form, Input, Modal, Popconfirm, Row, Tag, Tooltip } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { MONITORING_META, type ExternalRef, type MonitoringStatus } from '../../../shared/integrations';
import { errorText, http } from '../lib/api';
import { fmtDateTime, fromNow } from '../lib/format';
import { useInvalidate } from '../lib/queries';
import { useSession } from '../lib/session';

/** Monitoring status reported through the API */
export function MonitoringTag({ status, message, source, at }: { status: MonitoringStatus | null; message: string | null; source: string | null; at: string | null }) {
  if (!status) return null;
  return (
    <Tooltip title={[message, source && `Source: ${source}`, at && `Checked ${fromNow(at)} (${fmtDateTime(at)})`].filter(Boolean).join(' · ')}>
      <Tag color={MONITORING_META[status].color} style={{ marginInlineStart: 8 }}>
        Monitoring: {MONITORING_META[status].label}
      </Tag>
    </Tooltip>
  );
}

/** Tickets and links in other systems (ITSM, monitoring, vendor portal …); shown only when there is something or the user can add */
export function ExternalRefsCard({ assetId }: { assetId: string }) {
  const { can } = useSession();
  const { message } = App.useApp();
  const invalidate = useInvalidate();
  const [form] = Form.useForm();
  const [open, setOpen] = useState(false);
  const refs = useQuery({ queryKey: ['refs', assetId], queryFn: () => http.get<ExternalRef[]>(`/api/assets/${assetId}/refs`) });
  const writable = can('note.write');
  const list = refs.data ?? [];
  if (!list.length && !writable) return null;

  const remove = async (r: ExternalRef) => {
    try {
      await http.del(`/api/refs/${r.id}`);
      await invalidate();
    } catch (e) {
      message.error(errorText(e));
    }
  };

  return (
    <Card
      title={`Tickets & links${list.length ? ` (${list.length})` : ''}`}
      extra={
        writable && (
          <Button icon={<PlusOutlined />} onClick={() => setOpen(true)}>
            Add
          </Button>
        )
      }
    >
      {!list.length ? (
        <span className="muted">Link tickets, monitoring pages or vendor cases to this device.</span>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {list.map((r) => (
            <div key={r.id} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <Tag>{r.system}</Tag>
              <div style={{ flex: 1, minWidth: 0 }}>
                {r.url ? (
                  <a href={r.url} target="_blank" rel="noopener noreferrer" style={{ fontWeight: 600 }}>
                    {r.ref}
                  </a>
                ) : (
                  <span style={{ fontWeight: 600 }}>{r.ref}</span>
                )}
                {r.status && <Tag style={{ marginInlineStart: 8 }}>{r.status}</Tag>}
                {r.title && (
                  <div className="muted" style={{ fontSize: 13 }}>
                    {r.title}
                  </div>
                )}
              </div>
              {writable && (
                <Popconfirm title={`Remove ${r.ref}?`} onConfirm={() => remove(r)}>
                  <Button type="text" danger icon={<DeleteOutlined />} aria-label={`Remove ${r.ref}`} />
                </Popconfirm>
              )}
            </div>
          ))}
        </div>
      )}
      <Modal
        open={open}
        title="Add ticket or link"
        okText="Add"
        onCancel={() => setOpen(false)}
        destroyOnHidden
        onOk={async () => {
          const v = await form.validateFields();
          try {
            await http.post(`/api/assets/${assetId}/refs`, { ...v, url: v.url || null, title: v.title || null, status: v.status || null });
            form.resetFields();
            setOpen(false);
            await invalidate();
          } catch (e) {
            message.error(errorText(e));
          }
        }}
      >
        <Form form={form} layout="vertical">
          <Row gutter={12}>
            <Col span={10}>
              <Form.Item name="system" label="System" rules={[{ required: true, whitespace: true }]}>
                <Input placeholder="e.g. Jira, ServiceNow" />
              </Form.Item>
            </Col>
            <Col span={14}>
              <Form.Item name="ref" label="Number / ID" rules={[{ required: true, whitespace: true }]}>
                <Input placeholder="e.g. INC0012345" />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item name="url" label="Link" rules={[{ pattern: /^https?:\/\//i, message: 'Start with https://' }]}>
                <Input placeholder="https://" />
              </Form.Item>
            </Col>
            <Col span={16}>
              <Form.Item name="title" label="Title">
                <Input />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="status" label="Status">
                <Input placeholder="e.g. Open" />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </Card>
  );
}
