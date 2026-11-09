import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { App, Button, Col, DatePicker, Form, Input, InputNumber, Modal, Row, Select, Steps, Switch, Typography } from 'antd';
import { ArrowLeftOutlined, ArrowRightOutlined, CheckOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { ASSET_CATEGORIES, ASSET_STATUSES, ASSET_STATUS_META, ASSET_TYPES, assetTypeNoun, type AssetCategory, type Asset, type AssetType, type FieldDef } from '../../../shared/model';
import { errorText, http } from '../lib/api';
import { DATE_FORMAT } from '../lib/format';
import { useAssetTypes, useBuildings, useInvalidate, usePlants, useRacks } from '../lib/queries';
import { useSession } from '../lib/session';
import { DateStringInput } from './DateStringInput';
import { TypeIcon } from './Simple';

const MODEL_EXAMPLE: Partial<Record<AssetType, string>> = {
  switch: 'Catalyst 9300-48P',
  router: 'ISR 1100',
  firewall: 'FortiGate 100F',
  access_point: 'Meraki MR46',
  wlan_controller: 'Aruba 7210',
  server: 'PowerEdge R760',
  storage: 'PowerStore 500T',
  ups: 'Smart-UPS SRT 6000',
  pdu: 'Rack PDU 9000 switched',
  ot_device: 'SIMATIC S7-1500',
  printer: 'LaserJet M611',
  camera: 'AXIS P3265-LVE',
};

/** Usually not mounted in a rack – the rack fields are not offered in the wizard */
const NOT_IN_RACK = new Set<AssetType>(['access_point', 'printer', 'camera']);


const LAST_PLANT_KEY = 'cmdb.lastPlant';

type Defaults = Partial<Pick<Asset, 'type' | 'plant_id' | 'building_id' | 'floor_id' | 'rack_id' | 'rack_u'>>;

const Ctx = createContext<{ open: (defaults?: Defaults) => void }>({ open: () => undefined });
export const useAddDevice = () => useContext(Ctx);

export function AddDeviceProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<{ open: boolean; defaults: Defaults }>({ open: false, defaults: {} });
  const open = useCallback((defaults: Defaults = {}) => setState({ open: true, defaults }), []);
  const value = useMemo(() => ({ open }), [open]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <AddDeviceWizard open={state.open} defaults={state.defaults} onClose={() => setState((s) => ({ ...s, open: false }))} />
    </Ctx.Provider>
  );
}

function AttributeInput({ field }: { field: FieldDef }) {
  if (field.type === 'number') return <InputNumber style={{ width: '100%' }} addonAfter={field.unit} />;
  if (field.type === 'boolean') return <Switch />;
  if (field.type === 'select') return <Select allowClear options={field.options?.map((o) => ({ value: o, label: o }))} />;
  if (field.type === 'date') return <DateStringInput />;
  return <Input placeholder={field.placeholder} />;
}

/** Three short steps instead of one long form: type → name & place → optional details. */
function AddDeviceWizard({ open, defaults, onClose }: { open: boolean; defaults: Defaults; onClose: () => void }) {
  const [form] = Form.useForm();
  const { me, scoped } = useSession();
  const { message } = App.useApp();
  const navigate = useNavigate();
  const invalidate = useInvalidate();
  const plants = usePlants();
  const buildings = useBuildings();
  const [step, setStep] = useState(0);
  const [type, setType] = useState<AssetType | null>(null);
  const [saving, setSaving] = useState(false);
  const types = useAssetTypes();

  const plantId = Form.useWatch('plant_id', form) as string | undefined;
  const buildingId = Form.useWatch('building_id', form) as string | undefined;
  const rackId = Form.useWatch('rack_id', form) as string | undefined;
  const racks = useRacks({ buildingId }, !!buildingId);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    let lastPlant: string | null = null;
    try {
      lastPlant = localStorage.getItem(LAST_PLANT_KEY);
    } catch {
      /* ignore */
    }
    const onlyPlant = scoped && me.user.plantScope.length === 1 ? me.user.plantScope[0] : null;
    const plant = defaults.plant_id ?? onlyPlant ?? (lastPlant && plants.data?.some((p) => p.id === lastPlant) ? lastPlant : undefined);
    form.setFieldsValue({ plant_id: plant, building_id: defaults.building_id, floor_id: defaults.floor_id, rack_id: defaults.rack_id, rack_u: defaults.rack_u, rack_height_u: 1, status: 'active' });
    setType(defaults.type ?? null);
    setStep(defaults.type ? 1 : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const create = async () => {
    const v = await form.validateFields();
    const all = { ...form.getFieldsValue(true), ...v };
    const body = {
      type,
      name: all.name,
      status: all.status ?? 'active',
      plant_id: all.plant_id ?? null,
      building_id: all.building_id ?? null,
      floor_id: all.floor_id ?? null,
      room: all.room ?? null,
      rack_id: all.rack_id ?? null,
      rack_u: all.rack_id ? (all.rack_u ?? null) : null,
      rack_height_u: all.rack_height_u ?? 1,
      ip_address: all.ip_address ?? null,
      manufacturer: all.manufacturer ?? null,
      model: all.model ?? null,
      serial_number: all.serial_number ?? null,
      mac_address: all.mac_address ?? null,
      warranty_end: all.warranty_end ? dayjs(all.warranty_end).format('YYYY-MM-DD') : null,
      description: all.description ?? null,
      attributes: all.attributes ?? {},
    };
    setSaving(true);
    try {
      const created = await http.post<Asset>('/api/assets', body);
      try {
        if (body.plant_id) localStorage.setItem(LAST_PLANT_KEY, body.plant_id);
      } catch {
        /* ignore */
      }
      message.success(`${created.name} added`);
      await invalidate();
      onClose();
      navigate(`/assets/${created.id}`);
    } catch (e) {
      message.error(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const next = async () => {
    await form.validateFields();
    setStep((s) => s + 1);
  };

  const typeDef = type ? ASSET_TYPES[type] : null;
  const plantBuildings = (buildings.data ?? []).filter((b) => b.plant_id === plantId);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title="Add a device"
      width={760}
      destroyOnHidden
      footer={
        step === 0 ? null : (
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <Button size="large" icon={<ArrowLeftOutlined />} onClick={() => setStep((s) => s - 1)}>
              Back
            </Button>
            <div style={{ display: 'flex', gap: 8 }}>
              {step === 1 && (
                <Button size="large" onClick={next} icon={<ArrowRightOutlined />} iconPosition="end">
                  More details
                </Button>
              )}
              <Button size="large" type="primary" icon={<CheckOutlined />} loading={saving} onClick={create}>
                Add device
              </Button>
            </div>
          </div>
        )
      }
    >
      <Steps
        size="small"
        current={step}
        style={{ margin: '8px 0 24px' }}
        items={[{ title: 'Type' }, { title: 'Name & location' }, { title: 'Details (optional)' }]}
      />
      {step === 0 && (
        <Row gutter={[14, 14]}>
          {(Object.keys(ASSET_CATEGORIES) as AssetCategory[]).map((c) => {
            const inCategory = types.offered.filter((t) => ASSET_TYPES[t].category === c);
            if (!inCategory.length) return null;
            return [
              <Col span={24} key={c} style={{ marginBottom: -6 }}>
                <Typography.Text type="secondary" strong style={{ textTransform: 'uppercase', fontSize: 11.5, letterSpacing: 0.4 }}>
                  {ASSET_CATEGORIES[c].label}
                </Typography.Text>
              </Col>,
              ...inCategory.map((t) => (
                <Col xs={24} sm={12} key={t} style={{ display: 'flex' }}>
                  <button
                    type="button"
                    className="stat-tile"
                    style={{ width: '100%', height: '100%' }}
                    onClick={() => {
                      setType(t);
                      form.setFieldValue('rack_height_u', ASSET_TYPES[t].rackHeight);
                      setStep(1);
                    }}
                  >
                    <TypeIcon type={t} large />
                    <span>
                      <div style={{ fontSize: 18, fontWeight: 700 }}>{ASSET_TYPES[t].label}</div>
                      <div className="stat-label">{ASSET_TYPES[t].hint}</div>
                    </span>
                  </button>
                </Col>
              )),
            ];
          })}
        </Row>
      )}
      <Form form={form} layout="vertical" requiredMark={(label, { required }) => (required ? <>{label} *</> : label)} preserve>
        {step === 1 && typeDef && (
          <Row gutter={16}>
            <Col span={24}>
              <Form.Item name="name" label={`Name of the ${assetTypeNoun(type!)} (hostname)`} rules={[{ required: true, whitespace: true, message: 'Please enter a name' }]}>
                <Input size="large" placeholder={`e.g. ${typeDef.example}`} autoFocus />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="plant_id" label="Plant" rules={[{ required: true, message: 'Please choose the plant' }]}>
                <Select
                  showSearch
                  optionFilterProp="label"
                  placeholder="Choose plant"
                  options={(plants.data ?? []).map((p) => ({ value: p.id, label: `${p.code} – ${p.name}` }))}
                  onChange={() => form.setFieldsValue({ building_id: undefined, rack_id: undefined })}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="building_id" label="Building">
                <Select
                  allowClear
                  disabled={!plantId}
                  placeholder={plantId ? 'Choose building' : 'Choose a plant first'}
                  options={plantBuildings.map((b) => ({ value: b.id, label: `${b.code} – ${b.name}` }))}
                  onChange={() => form.setFieldsValue({ rack_id: undefined })}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="room" label="Room / place">
                <Input placeholder={type === 'access_point' ? 'e.g. Office 1.12, Hall 1 north' : 'e.g. Server room'} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="ip_address" label="IP address" rules={[{ pattern: /^([0-9]{1,3}\.){3}[0-9]{1,3}(\/\d{1,2})?$|^[0-9a-fA-F:]+(\/\d{1,3})?$/, message: 'Not a valid IP address' }]}>
                <Input className="mono" placeholder="e.g. 10.10.20.42" />
              </Form.Item>
            </Col>
            {typeDef.physical && !NOT_IN_RACK.has(type!) && (
              <>
                <Col xs={24} md={12}>
                  <Form.Item name="rack_id" label="Rack">
                    <Select
                      allowClear
                      disabled={!buildingId}
                      placeholder={buildingId ? 'Choose rack (optional)' : 'Choose a building first'}
                      options={(racks.data ?? []).map((r) => ({ value: r.id, label: `${r.name}${r.room ? ` · ${r.room}` : ''} – ${r.height_u - Number(r.used_u ?? 0)} U free` }))}
                    />
                  </Form.Item>
                </Col>
                <Col xs={12} md={6}>
                  <Form.Item name="rack_u" label="Lowest unit (U)">
                    <InputNumber min={1} max={60} disabled={!rackId} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col xs={12} md={6}>
                  <Form.Item name="rack_height_u" label="Height (U)">
                    <InputNumber min={1} max={20} disabled={!rackId} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
              </>
            )}
            <Col xs={24} md={12}>
              <Form.Item name="model" label="Model">
                <Input placeholder={MODEL_EXAMPLE[type!] ? `e.g. ${MODEL_EXAMPLE[type!]}` : undefined} />
              </Form.Item>
            </Col>
          </Row>
        )}
        {step === 2 && typeDef && (
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item name="manufacturer" label="Manufacturer">
                <Input />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="serial_number" label="Serial number">
                <Input className="mono" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="mac_address" label="MAC address" rules={[{ pattern: /^([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$|^([0-9a-fA-F]{4}\.){2}[0-9a-fA-F]{4}$/, message: 'Not a valid MAC address' }]}>
                <Input className="mono" placeholder="aa:bb:cc:dd:ee:ff" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="warranty_end" label="Warranty / support until">
                <DatePicker format={DATE_FORMAT} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="status" label="Status">
                <Select options={ASSET_STATUSES.map((s) => ({ value: s, label: ASSET_STATUS_META[s].label }))} />
              </Form.Item>
            </Col>
            {[...(typeDef.fields as readonly FieldDef[]).slice(0, 6), ...(types.settings.customFields[type!] ?? [])].map((f) => (
              <Col xs={24} md={12} key={f.key}>
                <Form.Item name={['attributes', f.key]} label={f.label} valuePropName={f.type === 'boolean' ? 'checked' : 'value'}>
                  <AttributeInput field={f} />
                </Form.Item>
              </Col>
            ))}
            <Col span={24}>
              <Form.Item name="description" label="Note">
                <Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} placeholder="Anything colleagues should know" />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Typography.Text type="secondary">You can add or change everything later on the device page.</Typography.Text>
            </Col>
          </Row>
        )}
      </Form>
    </Modal>
  );
}

