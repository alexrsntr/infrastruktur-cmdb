import { useEffect, useState } from 'react';
import { App, Col, Form, Input, Modal, Radio, Row, Select, Space, Spin, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { ASSET_TYPE_KEYS, RELATION_TYPES, RELATION_TYPE_KEYS, type Asset, type AssetType, type RelationType } from '../../../shared/model';
import { errorText, http } from '../lib/api';
import { useInvalidate } from '../lib/queries';
import { AssetTypeTag } from './Tags';

interface AssetOption {
  id: string;
  name: string;
  type: AssetType;
  status: string;
  ip_address: string | null;
  plant_code: string | null;
}

/** Sensible default relation for a pair of types */
function suggest(type: AssetType): { relation: RelationType; targetType?: AssetType } {
  switch (type) {
    case 'access_point':
      return { relation: 'uplink', targetType: 'switch' };
    case 'vm':
      return { relation: 'runs_on', targetType: 'server' };
    case 'server':
      return { relation: 'powered_by', targetType: 'ups' };
    case 'switch':
      return { relation: 'uplink', targetType: 'switch' };
    default:
      return { relation: 'uplink', targetType: 'switch' };
  }
}

export function RelationFormModal({ open, onClose, asset }: { open: boolean; onClose: () => void; asset: Asset }) {
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const invalidate = useInvalidate();
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const targetType = Form.useWatch('targetType', form) as AssetType | undefined;
  const direction = Form.useWatch('direction', form) as 'out' | 'in' | undefined;
  const relation = Form.useWatch('relation', form) as RelationType | undefined;

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (!open) return;
    const s = suggest(asset.type);
    form.resetFields();
    form.setFieldsValue({ relation: s.relation, direction: 'out', targetType: s.targetType });
    setSearch('');
  }, [open, asset.type, form]);

  const options = useQuery({
    queryKey: ['asset-options', debounced, targetType, asset.plant_id],
    queryFn: () => http.get<AssetOption[]>('/api/assets/options', { q: debounced || undefined, type: targetType, sort: 'name' }),
    enabled: open,
  });

  const submit = async () => {
    const v = await form.validateFields();
    const body =
      v.direction === 'out'
        ? { source_id: asset.id, target_id: v.other, relation: v.relation, source_port: v.localPort, target_port: v.remotePort, note: v.note }
        : { source_id: v.other, target_id: asset.id, relation: v.relation, source_port: v.remotePort, target_port: v.localPort, note: v.note };
    setSaving(true);
    try {
      await http.post('/api/relations', body);
      message.success('Relation added');
      await invalidate();
      onClose();
    } catch (e) {
      message.error(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const verb = relation ? (direction === 'in' ? RELATION_TYPES[relation].inverse : RELATION_TYPES[relation].label) : '';

  return (
    <Modal open={open} onCancel={onClose} onOk={submit} confirmLoading={saving} title={`Add relation – ${asset.name}`} okText="Add relation" width={640} destroyOnHidden>
      <Form form={form} layout="vertical" requiredMark="optional">
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="relation" label="Relation" rules={[{ required: true }]}>
              <Select options={RELATION_TYPE_KEYS.map((k) => ({ value: k, label: `${RELATION_TYPES[k].label} / ${RELATION_TYPES[k].inverse}` }))} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="direction" label="Direction">
              <Radio.Group optionType="button" buttonStyle="solid" options={[{ value: 'out', label: 'This → other' }, { value: 'in', label: 'Other → this' }]} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="targetType" label="Other asset type">
              <Select allowClear placeholder="Any" options={ASSET_TYPE_KEYS.map((t) => ({ value: t, label: <AssetTypeTag type={t} /> }))} onChange={() => form.setFieldValue('other', undefined)} />
            </Form.Item>
          </Col>
          <Col span={16}>
            <Form.Item name="other" label="Other asset" rules={[{ required: true, message: 'Select an asset' }]}>
              <Select
                showSearch
                filterOption={false}
                onSearch={setSearch}
                placeholder="Search by name or IP…"
                notFoundContent={options.isFetching ? <Spin size="small" /> : 'No assets found'}
                options={(options.data ?? [])
                  .filter((o) => o.id !== asset.id)
                  .map((o) => ({
                    value: o.id,
                    label: (
                      <Space size={6}>
                        <AssetTypeTag type={o.type} short />
                        <strong>{o.name}</strong>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {[o.plant_code, o.ip_address].filter(Boolean).join(' · ')}
                        </Typography.Text>
                      </Space>
                    ),
                  }))}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="localPort" label="Port on this asset">
              <Input placeholder="e.g. eth0, Te1/1/1" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="remotePort" label="Port on other asset">
              <Input placeholder="e.g. Gi1/0/24" />
            </Form.Item>
          </Col>
          <Col span={24}>
            <Form.Item name="note" label="Note">
              <Input />
            </Form.Item>
          </Col>
        </Row>
        {verb && (
          <Typography.Text type="secondary">
            Reads as: <strong>{asset.name}</strong> {verb.toLowerCase()} <strong>selected asset</strong>
          </Typography.Text>
        )}
      </Form>
    </Modal>
  );
}
