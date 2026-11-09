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
  /** only shown when editing – new sites get "Server room", "Site A", "Site B" or "Witness" */
  name: string;
  role: DcSiteRole;
  building_id?: string;
  /** set (also to '') when a new building is entered by name */
  newBuilding?: string | null;
  room?: string | null;
}

const NEW_BUILDING = '__new__';

const DEFAULT_SITES: Record<DatacenterKind, SiteRow[]> = {
  single: [{ name: '', role: 'primary' }],
  stretched: [
    { name: '', role: 'primary' },
    { name: '', role: 'secondary' },
  ],
};

function siteTitle(kind: DatacenterKind, s: SiteRow, i: number) {
  if (s.role === 'witness') return 'Witness site (optional)';
  if (kind === 'single') return 'Where is the server room?';
  return i === 0 ? 'Site A' : 'Site B';
}

/**
 * Create or edit a data center. Creating needs just a building (an existing one or a new one by name) –
 * name, site names and description are optional.
 */
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
  const [kind, setKind] = useState<DatacenterKind>('single');
  const [sites, setSites] = useState<SiteRow[]>(DEFAULT_SITES.single);
  const plantId = Form.useWatch('plant_id', form) as string | undefined;
  const racks = useRacks({ plantId }, open && !!plantId);
  const editing = !!datacenter;

  const scopedPlant = me.user.plantScope.length === 1 ? me.user.plantScope[0] : undefined;
  const onlyPlant = plants.data?.length === 1 ? plants.data[0].id : undefined;
  const fixedPlant = datacenter?.plant_id ?? defaultPlantId ?? scopedPlant ?? onlyPlant;
  const plant = (plants.data ?? []).find((p) => p.id === plantId);
  const plantBuildings = useMemo(() => (buildings.data ?? []).filter((b) => b.plant_id === plantId), [buildings.data, plantId]);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    if (datacenter) {
      form.setFieldsValue({ name: datacenter.name, plant_id: datacenter.plant_id, description: datacenter.description });
      setKind(datacenter.kind);
      setSites(datacenter.sites.map((s) => ({ id: s.id, name: s.name, role: s.role, building_id: s.building_id, room: s.room })));
    } else {
      form.setFieldsValue({ plant_id: fixedPlant });
      setKind('single');
      setSites(DEFAULT_SITES.single.map((s) => ({ ...s })));
    }
  }, [open, datacenter?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // New data center: preselect the building when the plant has exactly one, ask for a new one when it has none
  useEffect(() => {
    if (!open || editing || !plantId || buildings.isLoading) return;
    setSites((list) =>
      list.map((s, i) => {
        if (i > 0 || s.building_id || s.newBuilding != null) return s;
        if (plantBuildings.length === 1) return { ...s, building_id: plantBuildings[0].id };
        if (plantBuildings.length === 0) return { ...s, newBuilding: '' };
        return s;
      }),
    );
  }, [open, editing, plantId, plantBuildings, buildings.isLoading]);

  /** Rooms that already have racks – offered as suggestions per building */
  const roomsByBuilding = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const r of racks.data ?? []) if (r.room) (m.get(r.building_id) ?? m.set(r.building_id, new Set()).get(r.building_id)!).add(r.room);
    return m;
  }, [racks.data]);

  const changeKind = (k: DatacenterKind) => {
    setKind(k);
    if (k === 'single') setSites((s) => [{ ...(s[0] ?? DEFAULT_SITES.single[0]), role: 'primary' }]);
    else setSites((s) => [s[0] ?? { ...DEFAULT_SITES.stretched[0] }, s.find((x, i) => i > 0 && x.role !== 'witness') ?? { ...DEFAULT_SITES.stretched[1] }, ...s.filter((x) => x.role === 'witness')]);
  };
  const updateSite = (i: number, patch: Partial<SiteRow>) => setSites((list) => list.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const hasWitness = sites.some((s) => s.role === 'witness');

  const submit = async () => {
    const v = await form.validateFields();
    const missing = sites.findIndex((s) => (s.newBuilding != null ? !s.newBuilding.trim() : !s.building_id));
    if (missing >= 0) {
      message.error(sites[missing].newBuilding != null ? 'Enter the name of the new building' : `Choose a building for ${siteTitle(kind, sites[missing], missing).replace(/\?$/, '').toLowerCase()}`);
      return;
    }
    const body: DatacenterInput = {
      plant_id: v.plant_id,
      name: v.name?.trim() || null,
      kind,
      description: v.description ?? null,
      sites: sites.map((s) => ({
        id: s.id ?? null,
        name: s.name.trim() || null,
        role: s.role,
        building_id: s.newBuilding != null ? null : s.building_id!,
        new_building_name: s.newBuilding != null ? s.newBuilding.trim() : null,
        room: s.room?.trim() || null,
      })),
    };
    setSaving(true);
    try {
      const saved = datacenter
        ? await http.put<DatacenterDetail>(`/api/datacenters/${datacenter.id}`, body)
        : await http.post<DatacenterDetail>('/api/datacenters', body);
      message.success(datacenter ? 'Data center saved' : `${saved.name} created`);
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8 }}>
        <Typography.Text strong style={{ fontSize: 15 }}>
          {siteTitle(kind, s, i)}
        </Typography.Text>
        {s.role === 'witness' && (
          <Button type="text" danger icon={<DeleteOutlined />} onClick={() => setSites((list) => list.filter((_, j) => j !== i))}>
            Remove
          </Button>
        )}
      </div>
      <Row gutter={12}>
        <Col xs={24} md={12}>
          {s.newBuilding != null ? (
            <Input
              value={s.newBuilding}
              onChange={(e) => updateSite(i, { newBuilding: e.target.value })}
              placeholder="Name of the new building, e.g. Main building"
              maxLength={200}
              aria-label="New building"
              addonAfter={
                plantBuildings.length > 0 ? (
                  <Typography.Link onClick={() => updateSite(i, { newBuilding: null })} style={{ fontSize: 13 }}>
                    choose existing
                  </Typography.Link>
                ) : undefined
              }
            />
          ) : (
            <Select
              style={{ width: '100%' }}
              value={s.building_id}
              onChange={(id: string) => (id === NEW_BUILDING ? updateSite(i, { building_id: undefined, newBuilding: '', room: null }) : updateSite(i, { building_id: id, room: null }))}
              placeholder={plantId ? 'Building' : 'Choose the plant first'}
              disabled={!plantId}
              showSearch
              optionFilterProp="label"
              options={[
                ...plantBuildings.map((b) => ({ value: b.id, label: `${b.code} – ${b.name}` })),
                { value: NEW_BUILDING, label: '+ New building …' },
              ]}
              aria-label="Building"
            />
          )}
        </Col>
        <Col xs={24} md={12}>
          <AutoComplete
            style={{ width: '100%' }}
            value={s.room ?? ''}
            onChange={(room) => updateSite(i, { room })}
            placeholder="Room (optional), e.g. Server room 1"
            options={[...(s.building_id ? (roomsByBuilding.get(s.building_id) ?? []) : [])].map((r) => ({ value: r }))}
            aria-label="Room"
          />
        </Col>
        {editing && (
          <Col xs={24} md={12} style={{ marginTop: 8 }}>
            <Input value={s.name} onChange={(e) => updateSite(i, { name: e.target.value })} placeholder="Site name, e.g. Site A" maxLength={60} aria-label="Site name" addonBefore="Name" />
          </Col>
        )}
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
      title={datacenter ? `Edit ${datacenter.name}` : `New data center${fixedPlant && plant ? ` in ${plant.code}` : ''}`}
      width={680}
      destroyOnHidden
    >
      <Form form={form} layout="vertical">
        <Form.Item name="plant_id" label="Plant" rules={[{ required: true, message: 'Choose a plant' }]} hidden={!!fixedPlant}>
          <Select
            showSearch
            optionFilterProp="label"
            options={(plants.data ?? []).map((p) => ({ value: p.id, label: `${p.code} – ${p.name}` }))}
            onChange={() => setSites((list) => list.map((s) => ({ ...s, building_id: undefined, newBuilding: null, room: null })))}
          />
        </Form.Item>
        <Segmented
          block
          size="large"
          value={kind}
          onChange={(k) => changeKind(k as DatacenterKind)}
          options={[
            { value: 'single', label: 'One server room' },
            { value: 'stretched', label: 'Two buildings (stretched)' },
          ]}
          style={{ marginBottom: 8 }}
        />
        <Typography.Paragraph type="secondary" style={{ fontSize: 13.5, marginBottom: 14 }}>
          {kind === 'stretched'
            ? 'Two server rooms in different buildings that work as one data center, e.g. a cluster with hosts in both rooms.'
            : 'All racks of the data center are in one room.'}{' '}
          Racks in the building and room are assigned automatically.
        </Typography.Paragraph>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 12 }}>{sites.map(siteEditor)}</div>
        {kind === 'stretched' && !hasWitness && (
          <Button type="link" icon={<PlusOutlined />} onClick={() => setSites((list) => [...list, { name: '', role: 'witness' }])} style={{ paddingInline: 0, marginBottom: 8 }}>
            Add witness site
          </Button>
        )}
        <Form.Item name="name" label="Name (optional)" rules={[{ max: 100 }]} style={{ marginBottom: editing ? undefined : 0 }}>
          <Input placeholder={plant ? `${plant.code} data center` : 'e.g. DC Munich'} />
        </Form.Item>
        {editing && (
          <Form.Item name="description" label="Description (optional)">
            <Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} placeholder="e.g. how the rooms are connected, which systems run where" />
          </Form.Item>
        )}
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
