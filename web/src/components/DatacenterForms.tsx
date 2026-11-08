import { useEffect, useMemo, useState } from 'react';
import { App, AutoComplete, Button, Col, Form, Input, InputNumber, Modal, Row, Segmented, Select, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import {
  DC_LINK_KINDS,
  DC_LINK_KIND_META,
  type DatacenterDetail,
  type DatacenterInput,
  type DatacenterKind,
  type DatacenterLink,
  type DcSiteRole,
} from '../../../shared/datacenters';
import { errorText, http } from '../lib/api';
import { useBuildings, useInvalidate, usePlants, useRacks } from '../lib/queries';
import { useSession } from '../lib/session';

interface SiteRow {
  id?: string | null;
  name: string;
  role: DcSiteRole;
  building_id?: string;
  room?: string | null;
}

const DEFAULT_SITES: Record<DatacenterKind, SiteRow[]> = {
  single: [{ name: 'Main room', role: 'primary' }],
  stretched: [
    { name: 'Site A', role: 'primary' },
    { name: 'Site B', role: 'secondary' },
  ],
};

/** Create or edit a data center with its sites (rooms). */
export function DatacenterFormModal({
  open,
  onClose,
  datacenter,
  defaultPlantId,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  datacenter?: DatacenterDetail | null;
  defaultPlantId?: string;
  onSaved?: (dc: DatacenterDetail) => void;
}) {
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const { me } = useSession();
  const invalidate = useInvalidate();
  const plants = usePlants();
  const buildings = useBuildings();
  const [saving, setSaving] = useState(false);
  const [kind, setKind] = useState<DatacenterKind>('stretched');
  const [sites, setSites] = useState<SiteRow[]>(DEFAULT_SITES.stretched);
  const plantId = Form.useWatch('plant_id', form) as string | undefined;
  const racks = useRacks({ plantId }, open && !!plantId);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    if (datacenter) {
      form.setFieldsValue({ name: datacenter.name, plant_id: datacenter.plant_id, description: datacenter.description });
      setKind(datacenter.kind);
      setSites(datacenter.sites.map((s) => ({ id: s.id, name: s.name, role: s.role, building_id: s.building_id, room: s.room })));
    } else {
      const scopedPlant = me.user.plantScope.length === 1 ? me.user.plantScope[0] : undefined;
      form.setFieldsValue({ plant_id: defaultPlantId ?? scopedPlant });
      setKind('stretched');
      setSites(DEFAULT_SITES.stretched.map((s) => ({ ...s })));
    }
  }, [open, datacenter?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const plantBuildings = useMemo(() => (buildings.data ?? []).filter((b) => b.plant_id === plantId), [buildings.data, plantId]);
  /** Rooms that already have racks – offered as suggestions per building */
  const roomsByBuilding = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const r of racks.data ?? []) if (r.room) (m.get(r.building_id) ?? m.set(r.building_id, new Set()).get(r.building_id)!).add(r.room);
    return m;
  }, [racks.data]);

  const changeKind = (k: DatacenterKind) => {
    setKind(k);
    if (k === 'single') setSites((s) => [{ ...(s[0] ?? DEFAULT_SITES.single[0]), role: 'primary' }]);
    else setSites((s) => [s[0] ?? DEFAULT_SITES.stretched[0], s.find((x, i) => i > 0 && x.role !== 'witness') ?? { ...DEFAULT_SITES.stretched[1] }, ...s.filter((x) => x.role === 'witness')]);
  };
  const updateSite = (i: number, patch: Partial<SiteRow>) => setSites((list) => list.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const hasWitness = sites.some((s) => s.role === 'witness');

  const submit = async () => {
    const v = await form.validateFields();
    const missing = sites.findIndex((s) => !s.building_id || !s.name.trim());
    if (missing >= 0) {
      message.error(`Choose a building for ${sites[missing].name || 'every site'}`);
      return;
    }
    const body: DatacenterInput = {
      plant_id: v.plant_id,
      name: v.name,
      kind,
      description: v.description ?? null,
      sites: sites.map((s) => ({ id: s.id ?? null, name: s.name.trim(), role: s.role, building_id: s.building_id!, room: s.room?.trim() || null })),
    };
    setSaving(true);
    try {
      const saved = datacenter
        ? await http.put<DatacenterDetail>(`/api/datacenters/${datacenter.id}`, body)
        : await http.post<DatacenterDetail>('/api/datacenters', body);
      message.success(datacenter ? 'Data center saved' : 'Data center created');
      await invalidate();
      onSaved?.(saved);
      onClose();
    } catch (e) {
      message.error(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const siteEditor = (s: SiteRow, i: number) => (
    <div key={i} className="dcf-site">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <Typography.Text strong style={{ fontSize: 15 }}>
          {s.role === 'witness' ? 'Witness site (optional)' : kind === 'single' ? 'Server room' : i === 0 ? 'Site A – primary' : 'Site B – secondary'}
        </Typography.Text>
        {s.role === 'witness' && (
          <Button type="text" danger icon={<DeleteOutlined />} onClick={() => setSites((list) => list.filter((_, j) => j !== i))}>
            Remove
          </Button>
        )}
      </div>
      <Row gutter={12}>
        <Col xs={24} md={7}>
          <Input value={s.name} onChange={(e) => updateSite(i, { name: e.target.value })} placeholder="Name, e.g. Site A" maxLength={60} aria-label="Site name" />
        </Col>
        <Col xs={24} md={9}>
          <Select
            style={{ width: '100%' }}
            value={s.building_id}
            onChange={(id) => updateSite(i, { building_id: id, room: null })}
            placeholder={plantId ? 'Building' : 'Choose the plant first'}
            disabled={!plantId}
            showSearch
            optionFilterProp="label"
            options={plantBuildings.map((b) => ({ value: b.id, label: `${b.code} – ${b.name}` }))}
            aria-label="Building"
          />
        </Col>
        <Col xs={24} md={8}>
          <AutoComplete
            style={{ width: '100%' }}
            value={s.room ?? ''}
            onChange={(room) => updateSite(i, { room })}
            placeholder="Room, e.g. Server room"
            options={[...(s.building_id ? (roomsByBuilding.get(s.building_id) ?? []) : [])].map((r) => ({ value: r }))}
            aria-label="Room"
          />
        </Col>
      </Row>
    </div>
  );

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={submit}
      confirmLoading={saving}
      okText={datacenter ? 'Save' : 'Create data center'}
      title={datacenter ? `Edit ${datacenter.name}` : 'New data center'}
      width={760}
      destroyOnHidden
    >
      <Form form={form} layout="vertical">
        <Row gutter={16}>
          <Col xs={24} md={14}>
            <Form.Item name="name" label="Name" rules={[{ required: true, whitespace: true, max: 100 }]}>
              <Input placeholder="e.g. DC Munich" autoFocus />
            </Form.Item>
          </Col>
          <Col xs={24} md={10}>
            <Form.Item name="plant_id" label="Plant" rules={[{ required: true, message: 'Choose a plant' }]}>
              <Select
                disabled={!!datacenter}
                showSearch
                optionFilterProp="label"
                options={(plants.data ?? []).map((p) => ({ value: p.id, label: `${p.code} – ${p.name}` }))}
                onChange={() => setSites((list) => list.map((s) => ({ ...s, building_id: undefined, room: null })))}
              />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item label="How is this data center built?">
          <Segmented
            block
            size="large"
            value={kind}
            onChange={(k) => changeKind(k as DatacenterKind)}
            options={[
              { value: 'single', label: 'One room' },
              { value: 'stretched', label: 'Stretched – two buildings' },
            ]}
          />
          <Typography.Text type="secondary" style={{ display: 'block', marginTop: 6, fontSize: 13.5 }}>
            {kind === 'stretched'
              ? 'Two server rooms in different buildings that work as one data center (e.g. a cluster with hosts in both rooms).'
              : 'All racks of this data center are in one room.'}{' '}
            Racks are assigned automatically by building and room.
          </Typography.Text>
        </Form.Item>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>{sites.map(siteEditor)}</div>
        {kind === 'stretched' && !hasWitness && (
          <Button icon={<PlusOutlined />} onClick={() => setSites((list) => [...list, { name: 'Witness', role: 'witness' }])} style={{ marginBottom: 16 }}>
            Add witness site
          </Button>
        )}
        <Form.Item name="description" label="Description (optional)">
          <Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} placeholder="e.g. how the rooms are connected, which systems run where" />
        </Form.Item>
      </Form>
      <style>{`.dcf-site { background: var(--cmdb-surface-2); border: 1px solid var(--cmdb-border); border-radius: 10px; padding: 12px 14px; }`}</style>
    </Modal>
  );
}

/** Add or edit a link (fibre trunk, WAN …) between two sites. */
export function DatacenterLinkModal({ open, onClose, datacenter, link }: { open: boolean; onClose: () => void; datacenter: DatacenterDetail; link?: DatacenterLink | null }) {
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const invalidate = useInvalidate();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    const main = datacenter.sites.filter((s) => s.role !== 'witness');
    form.setFieldsValue(
      link ?? { kind: 'fiber', site_a_id: main[0]?.id ?? datacenter.sites[0]?.id, site_b_id: main[1]?.id ?? datacenter.sites[1]?.id },
    );
  }, [open, link?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    const v = await form.validateFields();
    const body = { ...v, capacity: v.capacity || null, note: v.note || null, length_m: v.length_m ?? null };
    setSaving(true);
    try {
      if (link) await http.put(`/api/datacenter-links/${link.id}`, body);
      else await http.post(`/api/datacenters/${datacenter.id}/links`, body);
      message.success(link ? 'Link saved' : 'Link added');
      await invalidate();
      onClose();
    } catch (e) {
      message.error(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const siteOptions = datacenter.sites.map((s) => ({ value: s.id, label: `${s.name} · ${s.building_code}${s.room ? ` ${s.room}` : ''}` }));

  return (
    <Modal open={open} onCancel={onClose} onOk={submit} confirmLoading={saving} okText={link ? 'Save' : 'Add link'} title={link ? 'Edit site link' : 'Add a link between the sites'} width={620} destroyOnHidden>
      <Form form={form} layout="vertical">
        <Form.Item name="label" label="Name" rules={[{ required: true, whitespace: true, max: 100 }]}>
          <Input placeholder="e.g. Trunk North" autoFocus />
        </Form.Item>
        <Form.Item name="kind" label="Type">
          <Segmented block options={DC_LINK_KINDS.map((k) => ({ value: k, label: DC_LINK_KIND_META[k].label }))} />
        </Form.Item>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="site_a_id" label="From" rules={[{ required: true }]}>
              <Select options={siteOptions} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name="site_b_id"
              label="To"
              dependencies={['site_a_id']}
              rules={[
                { required: true },
                ({ getFieldValue }) => ({
                  validator: (_, v) => (v && v === getFieldValue('site_a_id') ? Promise.reject(new Error('Choose a different site')) : Promise.resolve()),
                }),
              ]}
            >
              <Select options={siteOptions} />
            </Form.Item>
          </Col>
          <Col span={14}>
            <Form.Item name="capacity" label="Capacity / cable">
              <Input placeholder="e.g. 24× OS2 single mode" />
            </Form.Item>
          </Col>
          <Col span={10}>
            <Form.Item name="length_m" label="Length">
              <InputNumber min={0} max={1000000} addonAfter="m" style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="note" label="Note (optional)">
          <Input placeholder="e.g. cable route, patch panel positions" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
