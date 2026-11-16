import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { App, AutoComplete, Button, Card, Col, Form, Input, Modal, Popconfirm, Row, Space, Table, Tag, Typography } from 'antd';
import { DeleteOutlined, EditOutlined, GlobalOutlined, PlusOutlined } from '@ant-design/icons';
import { WAN_TECHNOLOGIES, type WanLine } from '../../../shared/scorecard';
import { errorText, http } from '../lib/api';
import { fmtDate } from '../lib/format';
import { useInvalidate } from '../lib/queries';
import { useSession } from '../lib/session';
import { DateStringInput } from './DateStringInput';
import { SectionHead } from './PageParts';

export const useWanLines = (plantId: string) =>
  useQuery({ queryKey: ['wan-lines', plantId], queryFn: () => http.get<WanLine[]>(`/api/plants/${plantId}/wan-lines`) });

const dash = (v: string | null | undefined) => v || <span className="muted">–</span>;

/** WAN / internet lines of a plant: line, technology, provider / product, bandwidth */
export function WanLinesCard({ plantId }: { plantId: string }) {
  const { can } = useSession();
  const { message } = App.useApp();
  const invalidate = useInvalidate();
  const lines = useWanLines(plantId);
  const [modal, setModal] = useState<{ open: boolean; line?: WanLine }>({ open: false });
  const writable = can('asset.write');
  const editable = can('asset.edit');

  const remove = async (l: WanLine) => {
    try {
      await http.del(`/api/wan-lines/${l.id}`);
      message.success(`${l.name} removed`);
      await invalidate();
    } catch (e) {
      message.error(errorText(e));
    }
  };

  return (
    <Card>
      <SectionHead
        title={
          <span>
            <GlobalOutlined /> WAN lines{' '}
            <Typography.Text type="secondary" style={{ fontSize: 14, fontWeight: 400 }}>
              {lines.data?.length ?? 0} {lines.data?.length === 1 ? 'line' : 'lines'}
            </Typography.Text>
          </span>
        }
        extra={
          writable && (
            <Button icon={<PlusOutlined />} onClick={() => setModal({ open: true })}>
              Add WAN line
            </Button>
          )
        }
      />
      <Table<WanLine>
        rowKey="id"
        loading={lines.isLoading}
        dataSource={lines.data ?? []}
        pagination={false}
        scroll={{ x: 820 }}
        locale={{ emptyText: 'No WAN lines documented yet – add the MPLS, internet and backup lines of this plant.' }}
        columns={[
          { title: 'WAN line', dataIndex: 'name', width: 170, render: (v: string) => <strong>{v}</strong> },
          { title: 'Technology', dataIndex: 'technology', width: 150, render: (v: string | null) => (v ? <Tag color="blue">{v}</Tag> : dash(v)) },
          { title: 'Provider / product', dataIndex: 'provider', render: dash },
          { title: 'Bandwidth', dataIndex: 'bandwidth', width: 140, render: dash },
          { title: 'Circuit ID', dataIndex: 'circuit_id', width: 150, responsive: ['lg'], render: (v: string | null) => (v ? <span className="mono">{v}</span> : dash(v)) },
          { title: 'Contract end', dataIndex: 'contract_end', width: 130, responsive: ['lg'], render: (v: string | null) => (v ? fmtDate(v) : dash(v)) },
          { title: 'Note', dataIndex: 'note', ellipsis: true, responsive: ['xl'], render: (v: string | null) => <Typography.Text type="secondary">{dash(v)}</Typography.Text> },
          ...(editable
            ? [
                {
                  title: '',
                  key: 'actions',
                  width: 96,
                  render: (_: unknown, l: WanLine) => (
                    <Space size={0}>
                      <Button type="text" icon={<EditOutlined />} aria-label={`Edit ${l.name}`} onClick={() => setModal({ open: true, line: l })} />
                      {writable && (
                        <Popconfirm title={`Remove ${l.name}?`} onConfirm={() => remove(l)} okButtonProps={{ danger: true }}>
                          <Button type="text" danger icon={<DeleteOutlined />} aria-label={`Remove ${l.name}`} />
                        </Popconfirm>
                      )}
                    </Space>
                  ),
                },
              ]
            : []),
        ]}
      />
      <WanLineModal plantId={plantId} state={modal} count={lines.data?.length ?? 0} onClose={() => setModal({ open: false })} />
    </Card>
  );
}

const ORDINAL = ['First line', 'Second line', 'Third line', 'Fourth line', 'Fifth line'];

function WanLineModal({ plantId, state, count, onClose }: { plantId: string; state: { open: boolean; line?: WanLine }; count: number; onClose: () => void }) {
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const invalidate = useInvalidate();
  const [saving, setSaving] = useState(false);
  const l = state.line;

  useEffect(() => {
    if (state.open)
      form.setFieldsValue(
        l ? { ...l } : { name: ORDINAL[count] ?? `Line ${count + 1}`, technology: '', provider: '', bandwidth: '', circuit_id: '', contract_end: null, note: '' },
      );
  }, [state.open, l, count, form]);

  const submit = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      const body = { ...v, plant_id: plantId };
      if (l) await http.put(`/api/wan-lines/${l.id}`, body);
      else await http.post('/api/wan-lines', body);
      message.success(l ? 'WAN line saved' : 'WAN line added');
      await invalidate();
      onClose();
    } catch (e) {
      message.error(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={state.open} title={l ? `Edit ${l.name}` : 'Add WAN line'} okText="Save" confirmLoading={saving} onOk={submit} onCancel={onClose} destroyOnHidden width={640}>
      <Form form={form} layout="vertical">
        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Form.Item name="name" label="WAN line" rules={[{ required: true, whitespace: true, message: 'Enter a name' }]}>
              <Input placeholder="e.g. First line" maxLength={100} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="technology" label="Technology">
              <AutoComplete options={WAN_TECHNOLOGIES.map((t) => ({ value: t }))} placeholder="e.g. MPLS, LIA (Internet)" filterOption={(input, o) => String(o?.value ?? '').toLowerCase().includes(input.toLowerCase())} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="provider" label="Provider / product">
              <Input placeholder="e.g. IntraSelect FixConnect, Vivo" maxLength={200} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="bandwidth" label="Bandwidth">
              <Input placeholder="e.g. 100 Mbit, 1 Gbit, Ethernet" maxLength={100} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="circuit_id" label="Circuit ID / contract no.">
              <Input maxLength={200} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="contract_end" label="Contract end">
              <DateStringInput />
            </Form.Item>
          </Col>
          <Col span={24}>
            <Form.Item name="note" label="Note">
              <Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} maxLength={2000} />
            </Form.Item>
          </Col>
        </Row>
      </Form>
    </Modal>
  );
}
