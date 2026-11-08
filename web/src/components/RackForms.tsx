import { useEffect, useState } from 'react';
import { App, Col, Form, Input, InputNumber, Modal, Row, Segmented, Select, Space, Spin, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  ASSET_TYPES,
  RACK_ITEM_KINDS,
  RACK_ITEM_KIND_META,
  formatRackUnits,
  type AssetType,
  type Rack,
  type RackAsset,
  type RackItem,
} from '../../../shared/model';
import { errorText, http } from '../lib/api';
import { useBuilding, useInvalidate } from '../lib/queries';
import { AssetTypeTag } from './Tags';

// ---------------------------------------------------------------------------
// Rack create / edit
// ---------------------------------------------------------------------------

export function RackFormModal({ open, onClose, rack, buildingId, onSaved }: { open: boolean; onClose: () => void; rack?: Rack | null; buildingId: string; onSaved?: (r: Rack) => void }) {
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const invalidate = useInvalidate();
  const building = useBuilding(buildingId);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue(rack ?? { height_u: 42, numbering: 'bottom_up' });
  }, [open, rack?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    const v = await form.validateFields();
    const body = { building_id: buildingId, floor_id: v.floor_id ?? null, name: v.name, room: v.room ?? null, height_u: v.height_u, numbering: v.numbering, manufacturer: v.manufacturer ?? null, model: v.model ?? null, description: v.description ?? null };
    setSaving(true);
    try {
      const saved = rack ? await http.put<Rack>(`/api/racks/${rack.id}`, body) : await http.post<Rack>('/api/racks', body);
      message.success(rack ? 'Rack saved' : 'Rack created');
      await invalidate();
      onSaved?.(saved);
      onClose();
    } catch (e) {
      message.error(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onCancel={onClose} onOk={submit} confirmLoading={saving} title={rack ? `Edit rack ${rack.name}` : 'New rack'} okText={rack ? 'Save' : 'Create'} destroyOnHidden width={620}>
      <Form form={form} layout="vertical">
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="name" label="Rack name" rules={[{ required: true, whitespace: true, max: 50 }]}>
              <Input placeholder="e.g. R01 or FD-EG" autoFocus />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="height_u" label="Height" rules={[{ required: true }]} extra="Common: 42 U floor rack, 24 U / 15 U wall cabinet">
              <InputNumber min={1} max={60} addonAfter="U" style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="floor_id" label="Floor">
              <Select allowClear placeholder="Select floor" options={(building.data?.floors ?? []).map((f) => ({ value: f.id, label: f.name }))} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="room" label="Room">
              <Input placeholder="e.g. Server room" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="manufacturer" label="Manufacturer">
              <Input placeholder="e.g. Rittal" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="model" label="Model">
              <Input />
            </Form.Item>
          </Col>
          <Col span={24}>
            <Form.Item name="numbering" label="Unit numbering">
              <Segmented options={[{ value: 'bottom_up', label: 'U1 at the bottom (standard)' }, { value: 'top_down', label: 'U1 at the top' }]} />
            </Form.Item>
          </Col>
          <Col span={24}>
            <Form.Item name="description" label="Description">
              <Input.TextArea autoSize={{ minRows: 2, maxRows: 6 }} />
            </Form.Item>
          </Col>
        </Row>
      </Form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Mount a device or add other equipment
// ---------------------------------------------------------------------------

interface AssetOption {
  id: string;
  name: string;
  type: AssetType;
  rack_id: string | null;
  rack_name: string | null;
  rack_u: number | null;
  rack_height_u: number;
  building_name: string | null;
}

const DEFAULT_HEIGHT: Record<AssetType, number> = { switch: 1, access_point: 1, server: 2, vm: 1 };

export function MountModal({
  open,
  onClose,
  rack,
  startU,
  asset,
  item,
  mode: initialMode = 'device',
}: {
  open: boolean;
  onClose: () => void;
  rack: Pick<Rack, 'id' | 'name' | 'height_u' | 'numbering' | 'plant_id' | 'building_id'>;
  startU?: number | null;
  /** Move / resize an already mounted device */
  asset?: RackAsset | null;
  /** Edit existing equipment */
  item?: RackItem | null;
  mode?: 'device' | 'item';
}) {
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const invalidate = useInvalidate();
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState<'device' | 'item'>(initialMode);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const editing = !!asset || !!item;

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    setSearch('');
    if (item) {
      setMode('item');
      form.setFieldsValue({ kind: item.kind, label: item.label, u: item.position_u, height: item.height_u, note: item.note });
    } else if (asset) {
      setMode('device');
      form.setFieldsValue({ asset_id: asset.id, u: asset.rack_u ?? startU ?? 1, height: asset.rack_height_u });
    } else {
      setMode(initialMode);
      form.setFieldsValue({ u: startU ?? 1, height: 1, kind: 'patch_panel' });
    }
  }, [open, asset?.id, item?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const options = useQuery({
    queryKey: ['rack-mount-options', rack.plant_id, debounced],
    queryFn: () => http.get<AssetOption[]>('/api/assets/options', { plantId: rack.plant_id, type: 'switch,server,access_point', q: debounced || undefined }),
    enabled: open && mode === 'device' && !asset,
  });

  // The form always works with physical units (U1 = bottom). For top-down racks we also show the printed labels.
  const labelStart = (u: number, h: number) => rack.height_u - (u + h - 1) + 1;

  const submit = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      if (mode === 'device') {
        await http.patch(`/api/assets/${asset?.id ?? v.asset_id}/rack`, { rack_id: rack.id, rack_u: v.u, rack_height_u: v.height });
        message.success(asset ? 'Device moved' : 'Device mounted');
      } else if (item) {
        await http.put(`/api/rack-items/${item.id}`, { kind: v.kind, label: v.label, position_u: v.u, height_u: v.height, note: v.note ?? null });
        message.success('Equipment saved');
      } else {
        await http.post(`/api/racks/${rack.id}/items`, { kind: v.kind, label: v.label, position_u: v.u, height_u: v.height, note: v.note ?? null });
        message.success('Equipment added');
      }
      await invalidate();
      onClose();
    } catch (e) {
      message.error(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const u = Form.useWatch('u', form) as number | undefined;
  const h = Form.useWatch('height', form) as number | undefined;
  const title = asset ? `Move ${asset.name}` : item ? `Edit ${item.label}` : `Rack ${rack.name}: add`;

  return (
    <Modal open={open} onCancel={onClose} onOk={submit} confirmLoading={saving} title={title} okText={editing ? 'Save' : mode === 'device' ? 'Mount' : 'Add'} destroyOnHidden width={560}>
      {!editing && (
        <Segmented
          block
          style={{ marginBottom: 16 }}
          value={mode}
          onChange={(m) => setMode(m as 'device' | 'item')}
          options={[
            { value: 'device', label: 'Device from the CMDB' },
            { value: 'item', label: 'Other equipment (patch panel, UPS …)' },
          ]}
        />
      )}
      <Form form={form} layout="vertical">
        {mode === 'device' && !asset && (
          <Form.Item name="asset_id" label="Device" rules={[{ required: true, message: 'Select a device' }]} extra="Switches, servers and access points of this plant. A device already in a rack is moved.">
            <Select
              showSearch
              filterOption={false}
              onSearch={setSearch}
              placeholder="Search by name or IP…"
              notFoundContent={options.isFetching ? <Spin size="small" /> : 'No devices found'}
              onChange={(id) => {
                const o = options.data?.find((x) => x.id === id);
                if (o) form.setFieldValue('height', o.rack_height_u > 1 ? o.rack_height_u : DEFAULT_HEIGHT[o.type]);
              }}
              options={(options.data ?? []).map((o) => ({
                value: o.id,
                label: (
                  <Space size={6}>
                    <AssetTypeTag type={o.type} short />
                    <strong>{o.name}</strong>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {o.rack_name ? `in ${o.rack_name}${o.rack_u ? ` U${formatRackUnits(o.rack_u, o.rack_height_u)}` : ''}` : o.building_name ?? 'not in a rack'}
                    </Typography.Text>
                  </Space>
                ),
              }))}
            />
          </Form.Item>
        )}
        {mode === 'item' && (
          <Row gutter={12}>
            <Col span={10}>
              <Form.Item name="kind" label="Kind" rules={[{ required: true }]}>
                <Select options={RACK_ITEM_KINDS.map((k) => ({ value: k, label: RACK_ITEM_KIND_META[k].label }))} />
              </Form.Item>
            </Col>
            <Col span={14}>
              <Form.Item name="label" label="Label" rules={[{ required: true, whitespace: true, max: 100 }]}>
                <Input placeholder="e.g. Panel A 1–24" />
              </Form.Item>
            </Col>
          </Row>
        )}
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="u" label="Lowest unit" tooltip="Physical unit counted from the bottom of the rack (U1 = bottom)" rules={[{ required: true }]}>
              <InputNumber min={1} max={rack.height_u} addonBefore="U" style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="height" label="Height" rules={[{ required: true }]}>
              <InputNumber min={1} max={20} addonAfter="U" style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>
        {mode === 'item' && (
          <Form.Item name="note" label="Note">
            <Input />
          </Form.Item>
        )}
        {u && h ? (
          <Typography.Text type="secondary">
            Occupies U{u}
            {h > 1 ? `–U${u + h - 1}` : ''}
            {rack.numbering === 'top_down' ? ` (labelled U${labelStart(u, h)}${h > 1 ? `–U${labelStart(u, h) + h - 1}` : ''} on this rack)` : ''} of {rack.height_u} U.
          </Typography.Text>
        ) : null}
        {mode === 'device' && asset && (
          <div style={{ marginTop: 8 }}>
            <Typography.Text type="secondary">{ASSET_TYPES[asset.type].label} {asset.model ?? ''}</Typography.Text>
          </div>
        )}
      </Form>
    </Modal>
  );
}
