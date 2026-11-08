import { useEffect, useMemo, useState } from 'react';
import L from 'leaflet';
import { MapContainer, Marker, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import { App, Col, Form, Input, InputNumber, Modal, Row, Select, Typography } from 'antd';
import type { Building, Floor, Plant } from '../../../shared/model';
import { errorText, http } from '../lib/api';
import { useInvalidate, usePlants } from '../lib/queries';
import { useSession } from '../lib/session';

/** Converts empty strings / undefined to null so optional fields are cleared on the server. */
function nullify<T extends Record<string, unknown>>(values: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) out[k] = v === undefined || v === '' ? null : typeof v === 'string' ? v.trim() || null : v;
  return out as T;
}

const pinIcon = L.divIcon({
  className: '',
  html: '<div style="width:18px;height:18px;border-radius:50%;background:#f5222d;border:3px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.5)"></div>',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

function ClickToSet({ onPick }: { onPick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onPick(+e.latlng.lat.toFixed(6), +e.latlng.lng.toFixed(6));
    },
  });
  return null;
}

function Recenter({ center, zoom }: { center: L.LatLngTuple; zoom: number }) {
  const map = useMap();
  useEffect(() => {
    map.invalidateSize();
    map.setView(center, Math.max(map.getZoom(), zoom));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center[0], center[1]]);
  return null;
}

/** Small map: click to set latitude/longitude form fields. */
function CoordinatePicker({ lat, lng, fallback, zoom, onPick }: { lat?: number | null; lng?: number | null; fallback?: L.LatLngTuple; zoom: number; onPick: (lat: number, lng: number) => void }) {
  const { config } = useSession();
  const has = typeof lat === 'number' && typeof lng === 'number';
  const center: L.LatLngTuple = has ? [lat, lng] : (fallback ?? [48.5, 9.3]);
  return (
    <div>
      <div className="map-container" style={{ height: 200 }}>
        <MapContainer center={center} zoom={has || fallback ? zoom : 4} style={{ height: '100%', width: '100%' }}>
          <TileLayer url={config.mapTileUrl} attribution={config.mapTileAttribution} />
          <ClickToSet onPick={onPick} />
          <Recenter center={center} zoom={has ? zoom : 3} />
          {has && <Marker position={[lat, lng]} icon={pinIcon} />}
        </MapContainer>
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        Click on the map to set the coordinates.
      </Typography.Text>
    </div>
  );
}

function useTimezones() {
  return useMemo(() => {
    try {
      return Intl.supportedValuesOf('timeZone').map((z) => ({ value: z, label: z }));
    } catch {
      return ['Europe/Berlin', 'Europe/Budapest', 'America/New_York', 'Asia/Shanghai'].map((z) => ({ value: z, label: z }));
    }
  }, []);
}

// ---------------------------------------------------------------------------

type PlantValues = Omit<Plant, 'id' | 'created_at' | 'updated_at'>;

export function PlantFormModal({ open, onClose, plant, onSaved }: { open: boolean; onClose: () => void; plant?: Plant | null; onSaved?: (p: Plant) => void }) {
  const [form] = Form.useForm<PlantValues>();
  const { message } = App.useApp();
  const invalidate = useInvalidate();
  const timezones = useTimezones();
  const [saving, setSaving] = useState(false);
  const lat = Form.useWatch('latitude', form);
  const lng = Form.useWatch('longitude', form);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    if (plant) form.setFieldsValue(plant);
    else form.setFieldsValue({ timezone: 'Europe/Berlin' } as Partial<PlantValues>);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, plant?.id]);

  const submit = async () => {
    const v = await form.validateFields();
    const body = nullify({
      code: v.code,
      name: v.name,
      country: v.country,
      city: v.city,
      address: v.address,
      latitude: v.latitude,
      longitude: v.longitude,
      timezone: v.timezone,
      contact: v.contact,
      description: v.description,
    });
    setSaving(true);
    try {
      const saved = plant ? await http.put<Plant>(`/api/plants/${plant.id}`, body) : await http.post<Plant>('/api/plants', body);
      message.success(plant ? 'Plant saved' : 'Plant created');
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
    <Modal open={open} onCancel={onClose} onOk={submit} confirmLoading={saving} okText={plant ? 'Save' : 'Create'} title={plant ? `Edit plant ${plant.code}` : 'New plant'} width={820} destroyOnHidden>
      <Form form={form} layout="vertical" requiredMark="optional">
        <Row gutter={16}>
          <Col xs={8} md={6}>
            <Form.Item name="code" label="Code" rules={[{ required: true, whitespace: true, max: 20 }]} tooltip="Short unique code, e.g. MUC" normalize={(v: string) => v?.toUpperCase()}>
              <Input />
            </Form.Item>
          </Col>
          <Col xs={16} md={18}>
            <Form.Item name="name" label="Name" rules={[{ required: true, whitespace: true, max: 200 }]}>
              <Input />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="address" label="Address">
              <Input />
            </Form.Item>
          </Col>
          <Col xs={12} md={6}>
            <Form.Item name="city" label="City">
              <Input />
            </Form.Item>
          </Col>
          <Col xs={12} md={6}>
            <Form.Item name="country" label="Country">
              <Input />
            </Form.Item>
          </Col>
          <Col xs={24} md={10}>
            <Row gutter={12}>
              <Col span={12}>
                <Form.Item name="latitude" label="Latitude">
                  <InputNumber min={-90} max={90} step={0.0001} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="longitude" label="Longitude">
                  <InputNumber min={-180} max={180} step={0.0001} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={24}>
                <Form.Item name="timezone" label="Time zone">
                  <Select showSearch allowClear options={timezones} />
                </Form.Item>
              </Col>
              <Col span={24}>
                <Form.Item name="contact" label="Contact (IT site lead, phone, mail)">
                  <Input />
                </Form.Item>
              </Col>
            </Row>
          </Col>
          <Col xs={24} md={14}>
            <CoordinatePicker lat={lat} lng={lng} zoom={13} onPick={(la, ln) => form.setFieldsValue({ latitude: la, longitude: ln })} />
          </Col>
          <Col span={24} style={{ marginTop: 12 }}>
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

type BuildingValues = Pick<Building, 'plant_id' | 'code' | 'name' | 'description' | 'latitude' | 'longitude'>;

export function BuildingFormModal({
  open,
  onClose,
  building,
  plantId,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  building?: Building | null;
  plantId?: string;
  onSaved?: (b: Building) => void;
}) {
  const [form] = Form.useForm<BuildingValues>();
  const { message } = App.useApp();
  const invalidate = useInvalidate();
  const plants = usePlants();
  const [saving, setSaving] = useState(false);
  const lat = Form.useWatch('latitude', form);
  const lng = Form.useWatch('longitude', form);
  const selectedPlantId = Form.useWatch('plant_id', form);
  const selectedPlant = plants.data?.find((p) => p.id === selectedPlantId);
  const fallback: L.LatLngTuple | undefined =
    selectedPlant && typeof selectedPlant.latitude === 'number' && typeof selectedPlant.longitude === 'number' ? [selectedPlant.latitude, selectedPlant.longitude] : undefined;

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue(building ? building : ({ plant_id: plantId } as Partial<BuildingValues>));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, building?.id, plantId]);

  const submit = async () => {
    const v = await form.validateFields();
    const body = nullify({ plant_id: v.plant_id, code: v.code, name: v.name, description: v.description, latitude: v.latitude, longitude: v.longitude });
    setSaving(true);
    try {
      const saved = building ? await http.put<Building>(`/api/buildings/${building.id}`, body) : await http.post<Building>('/api/buildings', body);
      message.success(building ? 'Building saved' : 'Building created');
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
    <Modal open={open} onCancel={onClose} onOk={submit} confirmLoading={saving} okText={building ? 'Save' : 'Create'} title={building ? `Edit building ${building.name}` : 'New building'} width={760} destroyOnHidden>
      <Form form={form} layout="vertical" requiredMark="optional">
        <Row gutter={16}>
          <Col xs={24} md={10}>
            <Form.Item name="plant_id" label="Plant" rules={[{ required: true }]} extra={building ? 'Moving a building also moves its assets to the new plant.' : undefined}>
              <Select showSearch optionFilterProp="label" options={(plants.data ?? []).map((p) => ({ value: p.id, label: `${p.code} – ${p.name}` }))} />
            </Form.Item>
            <Form.Item name="code" label="Code" rules={[{ required: true, whitespace: true, max: 30 }]} tooltip="Unique within the plant, e.g. B01, H2, DC">
              <Input />
            </Form.Item>
            <Form.Item name="name" label="Name" rules={[{ required: true, whitespace: true, max: 200 }]}>
              <Input />
            </Form.Item>
            <Row gutter={12}>
              <Col span={12}>
                <Form.Item name="latitude" label="Latitude">
                  <InputNumber min={-90} max={90} step={0.0001} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="longitude" label="Longitude">
                  <InputNumber min={-180} max={180} step={0.0001} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
            </Row>
          </Col>
          <Col xs={24} md={14}>
            <CoordinatePicker lat={lat} lng={lng} fallback={fallback} zoom={16} onPick={(la, ln) => form.setFieldsValue({ latitude: la, longitude: ln })} />
          </Col>
          <Col span={24} style={{ marginTop: 12 }}>
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

export function FloorFormModal({
  open,
  onClose,
  floor,
  buildingId,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  floor?: Floor | null;
  buildingId: string;
  onSaved?: (f: Floor) => void;
}) {
  const [form] = Form.useForm<{ name: string; level: number }>();
  const { message } = App.useApp();
  const invalidate = useInvalidate();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue(floor ? { name: floor.name, level: floor.level } : { level: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, floor?.id]);

  const submit = async () => {
    const v = await form.validateFields();
    const body = { name: v.name.trim(), level: v.level ?? 0 };
    setSaving(true);
    try {
      const saved = floor ? await http.put<Floor>(`/api/floors/${floor.id}`, body) : await http.post<Floor>('/api/floors', { ...body, building_id: buildingId });
      message.success(floor ? 'Floor saved' : 'Floor created');
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
    <Modal open={open} onCancel={onClose} onOk={submit} confirmLoading={saving} okText={floor ? 'Save' : 'Create'} title={floor ? `Edit floor ${floor.name}` : 'New floor'} width={420} destroyOnHidden>
      <Form form={form} layout="vertical" requiredMark="optional">
        <Form.Item name="name" label="Name" rules={[{ required: true, whitespace: true, max: 100 }]}>
          <Input placeholder="e.g. Ground floor, 1st floor, Hall level" />
        </Form.Item>
        <Form.Item name="level" label="Level" tooltip="Used for ordering: -1 = basement, 0 = ground floor, 1 = first floor …" rules={[{ required: true }]}>
          <InputNumber min={-20} max={200} precision={0} style={{ width: 140 }} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
