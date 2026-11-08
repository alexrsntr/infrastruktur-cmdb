import { useEffect, useMemo, useRef, useState } from 'react';
import { App, Col, DatePicker, Divider, Form, Input, InputNumber, Modal, Row, Select, Space, Switch, Typography } from 'antd';
import dayjs from 'dayjs';
import {
  ASSET_STATUSES,
  ASSET_STATUS_META,
  ASSET_TYPES,
  ASSET_TYPE_KEYS,
  CRITICALITIES,
  CRITICALITY_META,
  type Asset,
  type AssetType,
  type FieldDef,
} from '../../../shared/model';
import { errorText, http } from '../lib/api';
import { DATE_FORMAT } from '../lib/format';
import { useBuilding, useBuildings, useInvalidate, usePlants, useRacks } from '../lib/queries';
import { ASSET_TYPE_ICONS } from './icons';

type FormValues = Omit<Asset, 'purchase_date' | 'warranty_end'> & {
  purchase_date: dayjs.Dayjs | null;
  warranty_end: dayjs.Dayjs | null;
};

function AttributeInput({ field }: { field: FieldDef }) {
  switch (field.type) {
    case 'number':
      return <InputNumber style={{ width: '100%' }} addonAfter={field.unit} />;
    case 'boolean':
      return <Switch />;
    case 'select':
      return <Select allowClear options={field.options?.map((o) => ({ value: o, label: o }))} />;
    default:
      return <Input placeholder={field.placeholder} />;
  }
}

export function AssetFormModal({
  open,
  onClose,
  asset,
  defaults,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  asset?: Asset | null;
  defaults?: Partial<Asset>;
  onSaved?: (asset: Asset) => void;
}) {
  const [form] = Form.useForm<FormValues>();
  const { message } = App.useApp();
  const invalidate = useInvalidate();
  const [saving, setSaving] = useState(false);
  const plants = usePlants();
  const buildings = useBuildings();

  const type = Form.useWatch('type', form) as AssetType | undefined;
  const plantId = Form.useWatch('plant_id', form) as string | null | undefined;
  const buildingId = Form.useWatch('building_id', form) as string | null | undefined;
  const building = useBuilding(buildingId ?? undefined);
  const rackId = Form.useWatch('rack_id', form) as string | null | undefined;
  const racks = useRacks({ buildingId: buildingId ?? undefined }, !!buildingId);

  // Initialise the form only when the dialog opens (props may be re-created on every parent render)
  const initRef = useRef({ asset, defaults, buildings: buildings.data });
  initRef.current = { asset, defaults, buildings: buildings.data };
  useEffect(() => {
    if (!open) return;
    const { asset: a, defaults: d, buildings: bs } = initRef.current;
    const src: Partial<Asset> = a ?? { type: 'switch', status: 'active', criticality: 'medium', tags: [], attributes: {}, rack_height_u: 1, ...d };
    if (!a && src.building_id && !src.plant_id) src.plant_id = bs?.find((b) => b.id === src.building_id)?.plant_id ?? null;
    form.resetFields();
    form.setFieldsValue({
      ...src,
      purchase_date: src.purchase_date ? dayjs(src.purchase_date) : null,
      warranty_end: src.warranty_end ? dayjs(src.warranty_end) : null,
    } as FormValues);
  }, [open, asset?.id, form]);

  const buildingOptions = useMemo(
    () => (buildings.data ?? []).filter((b) => b.plant_id === plantId).map((b) => ({ value: b.id, label: `${b.code} – ${b.name}` })),
    [buildings.data, plantId],
  );
  const floorOptions = useMemo(
    () => (building.data?.floors ?? []).map((f) => ({ value: f.id, label: f.name })),
    [building.data],
  );

  const submit = async () => {
    const v = await form.validateFields();
    const floorChanged = asset && asset.floor_id !== (v.floor_id ?? null);
    const payload = {
      ...v,
      plant_id: v.plant_id ?? null,
      building_id: v.building_id ?? null,
      floor_id: v.floor_id ?? null,
      map_x: asset && !floorChanged ? asset.map_x : (defaults?.map_x ?? null),
      map_y: asset && !floorChanged ? asset.map_y : (defaults?.map_y ?? null),
      purchase_date: v.purchase_date ? v.purchase_date.format('YYYY-MM-DD') : null,
      warranty_end: v.warranty_end ? v.warranty_end.format('YYYY-MM-DD') : null,
      tags: v.tags ?? [],
      attributes: v.attributes ?? {},
    };
    setSaving(true);
    try {
      const saved = asset ? await http.put<Asset>(`/api/assets/${asset.id}`, payload) : await http.post<Asset>('/api/assets', payload);
      message.success(asset ? 'Asset saved' : 'Asset created');
      await invalidate();
      onSaved?.(saved);
      onClose();
    } catch (e) {
      message.error(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const typeDef = type ? ASSET_TYPES[type] : undefined;

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={submit}
      confirmLoading={saving}
      okText={asset ? 'Save' : 'Create'}
      title={asset ? `Edit ${asset.name}` : `New ${typeDef?.label ?? 'asset'}`}
      width={940}
      destroyOnHidden
      styles={{ body: { maxHeight: '70vh', overflowY: 'auto', paddingRight: 8 } }}
    >
      <Form form={form} layout="vertical" requiredMark={(label, { required }) => (required ? <>{label} *</> : label)}>
        <Divider titlePlacement="start" plain style={{ marginTop: 0 }}>
          General
        </Divider>
        <Row gutter={16}>
          <Col xs={24} md={8}>
            <Form.Item name="type" label="Type" rules={[{ required: true }]}>
              <Select
                options={ASSET_TYPE_KEYS.map((t) => ({ value: t, label: <span>{ASSET_TYPE_ICONS[t]} {ASSET_TYPES[t].label}</span> }))}
                onChange={() => form.setFieldValue('attributes', {})}
              />
            </Form.Item>
          </Col>
          <Col xs={24} md={16}>
            <Form.Item name="name" label="Name / hostname" rules={[{ required: true, whitespace: true, max: 200 }]}>
              <Input placeholder="e.g. muc-b01-sw03" autoFocus />
            </Form.Item>
          </Col>
          <Col xs={12} md={8}>
            <Form.Item name="status" label="Status" rules={[{ required: true }]}>
              <Select options={ASSET_STATUSES.map((s) => ({ value: s, label: ASSET_STATUS_META[s].label }))} />
            </Form.Item>
          </Col>
          <Col xs={12} md={8}>
            <Form.Item name="criticality" label="Criticality" rules={[{ required: true }]}>
              <Select options={CRITICALITIES.map((c) => ({ value: c, label: CRITICALITY_META[c].label }))} />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="tags" label="Tags">
              <Select mode="tags" tokenSeparators={[',']} placeholder="Add tags" />
            </Form.Item>
          </Col>
        </Row>

        <Divider titlePlacement="start" plain>
          Location
        </Divider>
        <Row gutter={16}>
          <Col xs={24} md={8}>
            <Form.Item name="plant_id" label="Plant">
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                options={(plants.data ?? []).map((p) => ({ value: p.id, label: `${p.code} – ${p.name}` }))}
                onChange={() => form.setFieldsValue({ building_id: null, floor_id: null, rack_id: null, rack_u: null })}
              />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="building_id" label="Building">
              <Select allowClear showSearch optionFilterProp="label" disabled={!plantId} options={buildingOptions} onChange={() => form.setFieldsValue({ floor_id: null, rack_id: null, rack_u: null })} />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item name="floor_id" label="Floor" extra={typeDef?.physical ? 'Place it on the floor plan from the building page.' : undefined}>
              <Select allowClear disabled={!buildingId} options={floorOptions} loading={building.isLoading && !!buildingId} />
            </Form.Item>
          </Col>
          <Col xs={8}>
            <Form.Item name="room" label="Room">
              <Input />
            </Form.Item>
          </Col>
          <Col xs={8}>
            <Form.Item name="rack_id" label="Rack" extra={type === 'vm' ? 'VMs are not mounted in racks' : undefined}>
              <Select
                allowClear
                disabled={!buildingId || type === 'vm'}
                placeholder={buildingId ? 'Select rack' : 'Select a building first'}
                options={(racks.data ?? []).map((r) => ({ value: r.id, label: `${r.name}${r.room ? ` · ${r.room}` : ''} (${r.height_u - Number(r.used_u ?? 0)} U free)` }))}
                onChange={(id) => {
                  const r = racks.data?.find((x) => x.id === id);
                  if (r?.floor_id) form.setFieldValue('floor_id', r.floor_id);
                  if (!id) form.setFieldsValue({ rack_u: null });
                }}
              />
            </Form.Item>
          </Col>
          <Col xs={8}>
            <Space.Compact block>
              <Form.Item name="rack_u" label="Lowest unit" style={{ width: '55%' }}>
                <InputNumber min={1} max={60} addonBefore="U" disabled={!rackId} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="rack_height_u" label="Height" style={{ width: '45%', paddingLeft: 8 }}>
                <InputNumber min={1} max={20} addonAfter="U" disabled={!rackId} style={{ width: '100%' }} />
              </Form.Item>
            </Space.Compact>
          </Col>
        </Row>

        <Divider titlePlacement="start" plain>
          Hardware & network
        </Divider>
        <Row gutter={16}>
          <Col xs={12} md={6}>
            <Form.Item name="manufacturer" label="Manufacturer">
              <Input />
            </Form.Item>
          </Col>
          <Col xs={12} md={6}>
            <Form.Item name="model" label="Model">
              <Input />
            </Form.Item>
          </Col>
          <Col xs={12} md={6}>
            <Form.Item name="serial_number" label="Serial number">
              <Input />
            </Form.Item>
          </Col>
          <Col xs={12} md={6}>
            <Form.Item name="asset_tag" label="Asset tag / inventory no.">
              <Input />
            </Form.Item>
          </Col>
          <Col xs={12} md={6}>
            <Form.Item
              name="ip_address"
              label="IP address"
              rules={[{ pattern: /^([0-9]{1,3}\.){3}[0-9]{1,3}(\/\d{1,2})?$|^[0-9a-fA-F:]+(\/\d{1,3})?$/, message: 'Invalid IP address' }]}
            >
              <Input className="mono" />
            </Form.Item>
          </Col>
          <Col xs={12} md={6}>
            <Form.Item name="mac_address" label="MAC address" rules={[{ pattern: /^([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$|^([0-9a-fA-F]{4}\.){2}[0-9a-fA-F]{4}$/, message: 'Invalid MAC address' }]}>
              <Input className="mono" placeholder="aa:bb:cc:dd:ee:ff" />
            </Form.Item>
          </Col>
          <Col xs={12} md={6}>
            <Form.Item name="fqdn" label="FQDN">
              <Input className="mono" />
            </Form.Item>
          </Col>
          <Col xs={12} md={6}>
            <Form.Item name="os" label="OS / firmware">
              <Input />
            </Form.Item>
          </Col>
        </Row>

        {typeDef && typeDef.fields.length > 0 && (
          <>
            <Divider titlePlacement="start" plain>
              {typeDef.label} details
            </Divider>
            <Row gutter={16}>
              {typeDef.fields.map((f) => (
                <Col xs={12} md={6} key={f.key}>
                  <Form.Item name={['attributes', f.key]} label={f.label} valuePropName={f.type === 'boolean' ? 'checked' : 'value'}>
                    <AttributeInput field={f} />
                  </Form.Item>
                </Col>
              ))}
            </Row>
          </>
        )}

        <Divider titlePlacement="start" plain>
          Ownership & lifecycle
        </Divider>
        <Row gutter={16}>
          <Col xs={12} md={6}>
            <Form.Item name="owner" label="Owner / responsible">
              <Input />
            </Form.Item>
          </Col>
          <Col xs={12} md={6}>
            <Form.Item name="cost_center" label="Cost center">
              <Input />
            </Form.Item>
          </Col>
          <Col xs={12} md={6}>
            <Form.Item name="purchase_date" label="Purchase date">
              <DatePicker format={DATE_FORMAT} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col xs={12} md={6}>
            <Form.Item name="warranty_end" label="Warranty / support end">
              <DatePicker format={DATE_FORMAT} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={24}>
            <Form.Item name="description" label="Description">
              <Input.TextArea autoSize={{ minRows: 2, maxRows: 8 }} />
            </Form.Item>
          </Col>
        </Row>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          All changes are recorded in the change history.
        </Typography.Text>
      </Form>
    </Modal>
  );
}
